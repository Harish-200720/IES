-- 1. Persist the invoice type chosen at upload (Terminal page => TES) so the processor selects the right prompt.
ALTER TABLE invoice_jobs
    ADD COLUMN IF NOT EXISTS invoice_type varchar(16) NOT NULL DEFAULT 'STANDARD'
    CHECK (invoice_type IN ('STANDARD', 'TES'));

-- 2. Re-point the SOP mirror at the canonical field names. Migration 002 is immutable (checksummed),
--    so the trigger function is replaced here. Falls back to the pre-canonical keys for old revisions.
CREATE OR REPLACE FUNCTION sync_sop_invoice_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    vendor_name_value text;
    vendor_country_value text;
    vendor_tax_value text;
    resolved_vendor_id uuid;
    invoice_date_value text;
    due_date_value text;
    total_value text;
BEGIN
    vendor_name_value := NEW.extraction_json #>> '{vendor,name,value}';
    vendor_country_value := NEW.extraction_json #>> '{vendor,country,value}';
    vendor_tax_value := COALESCE(NEW.extraction_json #>> '{vendor,vendorTaxId,value}',
                                 NEW.extraction_json #>> '{vendor,taxRegistration,value}');
    IF vendor_name_value IS NOT NULL AND btrim(vendor_name_value) <> '' THEN
        resolved_vendor_id := md5(NEW.tenant_id::text || '|' || lower(btrim(vendor_name_value)))::uuid;
        INSERT INTO vendors(vendor_id, vendor_name, vendor_code, country, tax_reg_number, is_active, tenant_id)
        VALUES (resolved_vendor_id, vendor_name_value, NEW.extraction_json #>> '{vendor,vendorCode,value}',
                vendor_country_value, vendor_tax_value, true, NEW.tenant_id)
        ON CONFLICT (vendor_id) DO UPDATE SET vendor_name = EXCLUDED.vendor_name,
            country = COALESCE(EXCLUDED.country, vendors.country),
            tax_reg_number = COALESCE(EXCLUDED.tax_reg_number, vendors.tax_reg_number);
    END IF;
    invoice_date_value := NEW.extraction_json #>> '{header,invoiceDate,value}';
    due_date_value := NEW.extraction_json #>> '{header,dueDate,value}';
    total_value := NEW.extraction_json #>> '{amounts,total,value}';
    INSERT INTO invoice_headers(
        invoice_id, batch_id, invoice_number, invoice_date, due_date, vendor_id, currency,
        total_amount, processing_state, sharepoint_path, tenant_id, source_job_status, created_at, updated_at
    ) VALUES (
        NEW.id, NEW.batch_id, NEW.extraction_json #>> '{header,invoiceNumber,value}',
        CASE WHEN invoice_date_value ~ '^\d{4}-\d{2}-\d{2}$' THEN invoice_date_value::date END,
        CASE WHEN due_date_value ~ '^\d{4}-\d{2}-\d{2}$' THEN due_date_value::date END,
        resolved_vendor_id, NEW.extraction_json #>> '{header,currency,value}',
        CASE WHEN total_value ~ '^-?[0-9]+(?:\.[0-9]+)?$' THEN total_value::numeric END,
        CASE NEW.status
            WHEN 'QUEUED' THEN 'PendingExtraction' WHEN 'PREPROCESSING' THEN 'PendingExtraction'
            WHEN 'OCR_RUNNING' THEN 'PendingExtraction' WHEN 'MAPPING' THEN 'Extracted'
            WHEN 'VALIDATING' THEN 'Validating' WHEN 'PENDING_REVIEW' THEN 'PendingReview'
            WHEN 'COMPLETED' THEN 'Approved' WHEN 'REJECTED' THEN 'Rejected' ELSE 'Rejected' END,
        NEW.stored_filename, NEW.tenant_id, NEW.status, NEW.created_at, NEW.updated_at
    )
    ON CONFLICT (invoice_id) DO UPDATE SET
        invoice_number = EXCLUDED.invoice_number, invoice_date = EXCLUDED.invoice_date,
        due_date = EXCLUDED.due_date, vendor_id = EXCLUDED.vendor_id, currency = EXCLUDED.currency,
        total_amount = EXCLUDED.total_amount, processing_state = EXCLUDED.processing_state,
        sharepoint_path = EXCLUDED.sharepoint_path, source_job_status = EXCLUDED.source_job_status,
        updated_at = EXCLUDED.updated_at;
    INSERT INTO file_details(
        file_id, invoice_id, file_name, sharepoint_url, file_size, mime_type,
        tenant_id, sha256, stored_filename
    ) VALUES (
        NEW.id, NEW.id, NEW.original_filename, NEW.stored_filename, NEW.size_bytes,
        NEW.content_type, NEW.tenant_id, NEW.sha256, NEW.stored_filename
    )
    ON CONFLICT (file_id) DO UPDATE SET file_name = EXCLUDED.file_name,
        sharepoint_url = EXCLUDED.sharepoint_url, file_size = EXCLUDED.file_size,
        mime_type = EXCLUDED.mime_type, sha256 = EXCLUDED.sha256,
        stored_filename = EXCLUDED.stored_filename;
    RETURN NEW;
END;
$$;
