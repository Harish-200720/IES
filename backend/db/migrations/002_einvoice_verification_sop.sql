-- Canonical PostgreSQL implementation of the 13-table E-Invoice Verification SOP data model.
-- PostgreSQL folds the SOP's uppercase logical names to lowercase snake_case physical names.
-- The existing Node transaction tables remain internal implementation tables and are mirrored
-- into this business schema so the API can be upgraded without losing existing data.

CREATE TABLE batch_uploads (
    batch_id uuid PRIMARY KEY,
    batch_name varchar(200) NOT NULL,
    uploaded_by varchar(200) NOT NULL,
    uploaded_on timestamptz NOT NULL DEFAULT now(),
    file_count integer NOT NULL CHECK (file_count >= 0),
    status varchar(20) NOT NULL CHECK (status IN ('Pending', 'Processing', 'Completed', 'Failed')),
    tenant_id uuid NOT NULL REFERENCES tenants(id)
);

CREATE TABLE vendors (
    vendor_id uuid PRIMARY KEY,
    vendor_name varchar(300) NOT NULL,
    vendor_code varchar(100),
    country varchar(100),
    tax_reg_number varchar(100),
    is_active boolean NOT NULL DEFAULT true,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    UNIQUE (tenant_id, vendor_code)
);

CREATE TABLE invoice_headers (
    invoice_id uuid PRIMARY KEY,
    batch_id uuid NOT NULL REFERENCES batch_uploads(batch_id),
    invoice_number varchar(200),
    invoice_date date,
    due_date date,
    vendor_id uuid REFERENCES vendors(vendor_id),
    currency varchar(3),
    total_amount numeric(24,8),
    processing_state varchar(24) NOT NULL
        CHECK (processing_state IN ('Draft', 'PendingExtraction', 'Extracted', 'Validating',
                                    'PendingReview', 'Approved', 'Rejected', 'Interfaced')),
    sharepoint_path text,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    source_job_status varchar(40) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sop_invoice_headers_batch ON invoice_headers(batch_id);
CREATE INDEX idx_sop_invoice_headers_vendor ON invoice_headers(vendor_id);
CREATE INDEX idx_sop_invoice_headers_state ON invoice_headers(tenant_id, processing_state, created_at DESC);

CREATE TABLE line_items (
    line_id uuid PRIMARY KEY,
    invoice_id uuid NOT NULL REFERENCES invoice_headers(invoice_id) ON DELETE CASCADE,
    line_number integer,
    description text,
    quantity numeric(24,8),
    unit_price numeric(24,8),
    line_amount numeric(24,8),
    charge_code varchar(100),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    confidence numeric(7,6) CHECK (confidence BETWEEN 0 AND 1),
    raw_json jsonb,
    source_line_item_id uuid NOT NULL UNIQUE
);

CREATE INDEX idx_sop_line_items_invoice ON line_items(invoice_id, line_number);

CREATE TABLE audit_trails (
    audit_id uuid PRIMARY KEY,
    invoice_id uuid REFERENCES invoice_headers(invoice_id) ON DELETE CASCADE,
    action varchar(100) NOT NULL,
    performed_by varchar(200) NOT NULL,
    performed_on timestamptz NOT NULL DEFAULT now(),
    from_state varchar(24),
    to_state varchar(24),
    remarks text,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    batch_id uuid REFERENCES batch_uploads(batch_id) ON DELETE CASCADE,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    correlation_id uuid
);

CREATE INDEX idx_sop_audit_invoice ON audit_trails(invoice_id, performed_on);

CREATE TABLE exception_queue (
    exception_id uuid PRIMARY KEY,
    invoice_id uuid NOT NULL REFERENCES invoice_headers(invoice_id) ON DELETE CASCADE,
    exception_type varchar(20) NOT NULL CHECK (exception_type IN ('Mismatch', 'Missing', 'LowConfidence')),
    field_name varchar(300),
    expected_value text,
    actual_value text,
    resolved_by varchar(200),
    resolved_on timestamptz,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    severity varchar(16) CHECK (severity IN ('BLOCK', 'WARN', 'INFO')),
    message text,
    source_validation_issue_id uuid NOT NULL UNIQUE
);

CREATE INDEX idx_sop_exception_invoice ON exception_queue(invoice_id, resolved_on);

CREATE TABLE extraction_logs (
    log_id uuid PRIMARY KEY,
    invoice_id uuid NOT NULL REFERENCES invoice_headers(invoice_id) ON DELETE CASCADE,
    flow_run_id varchar(200),
    model_version varchar(200),
    start_time timestamptz NOT NULL,
    end_time timestamptz,
    overall_confidence numeric(7,6) CHECK (overall_confidence BETWEEN 0 AND 1),
    status varchar(20) NOT NULL CHECK (status IN ('Success', 'PartialSuccess', 'Failed')),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    revision integer NOT NULL,
    extraction_json jsonb NOT NULL,
    validation_json jsonb NOT NULL,
    source varchar(32) NOT NULL,
    created_by varchar(200) NOT NULL,
    UNIQUE (invoice_id, revision)
);

CREATE INDEX idx_sop_extraction_logs_invoice ON extraction_logs(invoice_id, start_time DESC);

CREATE TABLE field_extraction_details (
    detail_id uuid PRIMARY KEY,
    log_id uuid NOT NULL REFERENCES extraction_logs(log_id) ON DELETE CASCADE,
    field_name varchar(300) NOT NULL,
    extracted_value text,
    confidence numeric(7,6) CHECK (confidence BETWEEN 0 AND 1),
    was_overridden boolean NOT NULL DEFAULT false,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    value_json jsonb,
    value_number numeric(24,8),
    value_date date,
    source varchar(80),
    page_number integer CHECK (page_number IS NULL OR page_number > 0),
    UNIQUE (log_id, field_name)
);

CREATE INDEX idx_sop_field_details_log ON field_extraction_details(log_id);

CREATE TABLE validation_rules (
    rule_id uuid PRIMARY KEY,
    rule_name varchar(200) NOT NULL,
    rule_type varchar(20) NOT NULL CHECK (rule_type IN ('ClientFlag', 'MasterMatch', 'Threshold')),
    expression text NOT NULL,
    severity varchar(16) NOT NULL CHECK (severity IN ('Block', 'Warn', 'Info')),
    is_active boolean NOT NULL DEFAULT true,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, rule_name)
);

CREATE TABLE file_details (
    file_id uuid PRIMARY KEY,
    invoice_id uuid NOT NULL REFERENCES invoice_headers(invoice_id) ON DELETE CASCADE,
    file_name varchar(255) NOT NULL,
    sharepoint_url text NOT NULL,
    file_size bigint NOT NULL CHECK (file_size >= 0),
    mime_type varchar(100) NOT NULL,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    stored_filename varchar(255),
    UNIQUE (invoice_id, file_name)
);

CREATE INDEX idx_sop_file_details_invoice ON file_details(invoice_id);

CREATE TABLE gcc_invoice_records (
    record_id uuid PRIMARY KEY,
    invoice_id uuid NOT NULL REFERENCES invoice_headers(invoice_id),
    posting_date date,
    posting_reference varchar(200),
    interfaced_to varchar(100),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gcc_supplier_records (
    supplier_id uuid PRIMARY KEY,
    supplier_name varchar(300) NOT NULL,
    supplier_code varchar(100) NOT NULL,
    bank_account varchar(200),
    is_blocked boolean NOT NULL DEFAULT false,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    UNIQUE (tenant_id, supplier_code)
);

CREATE TABLE gcc_purchase_orders (
    po_id uuid PRIMARY KEY,
    po_number varchar(200) NOT NULL,
    supplier_id uuid REFERENCES gcc_supplier_records(supplier_id),
    po_amount numeric(24,8),
    currency varchar(3),
    status varchar(16) NOT NULL CHECK (status IN ('Open', 'Closed', 'Cancelled')),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    UNIQUE (tenant_id, po_number)
);

CREATE INDEX idx_sop_purchase_orders_supplier ON gcc_purchase_orders(supplier_id);

INSERT INTO validation_rules(rule_id, rule_name, rule_type, expression, severity, tenant_id)
SELECT md5(id::text || '|missing-mandatory')::uuid, 'Missing Mandatory Field', 'ClientFlag',
       'invoiceNumber, invoiceDate, vendor.name and amounts.total must be present', 'Block', id
FROM tenants
UNION ALL
SELECT md5(id::text || '|low-confidence')::uuid, 'Low Confidence', 'Threshold',
       'field confidence < 0.70', 'Warn', id FROM tenants
UNION ALL
SELECT md5(id::text || '|amount-mismatch')::uuid, 'Amount Mismatch', 'ClientFlag',
       'absolute(sum(line amounts) - header total) > 0.02', 'Block', id FROM tenants
UNION ALL
SELECT md5(id::text || '|invalid-currency')::uuid, 'Invalid Currency', 'MasterMatch',
       'currency is not a valid ISO 4217 code', 'Block', id FROM tenants
UNION ALL
SELECT md5(id::text || '|date-sanity')::uuid, 'Date Sanity', 'ClientFlag',
       'invoice date is in the future or more than 365 days old', 'Warn', id FROM tenants;

CREATE OR REPLACE FUNCTION sync_sop_batch_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO batch_uploads(batch_id, batch_name, uploaded_by, uploaded_on, file_count, status, tenant_id)
    VALUES (NEW.id, 'Batch-' || left(NEW.id::text, 8), NEW.submitted_by, NEW.created_at, NEW.document_count,
            CASE NEW.status WHEN 'QUEUED' THEN 'Pending' WHEN 'PROCESSING' THEN 'Processing'
                 WHEN 'COMPLETED' THEN 'Completed' ELSE 'Failed' END,
            NEW.tenant_id)
    ON CONFLICT (batch_id) DO UPDATE SET
        uploaded_by = EXCLUDED.uploaded_by, uploaded_on = EXCLUDED.uploaded_on,
        file_count = EXCLUDED.file_count, status = EXCLUDED.status;
    RETURN NEW;
END;
$$;

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
    vendor_tax_value := NEW.extraction_json #>> '{vendor,taxRegistration,value}';
    IF vendor_name_value IS NOT NULL AND btrim(vendor_name_value) <> '' THEN
        resolved_vendor_id := md5(NEW.tenant_id::text || '|' || lower(btrim(vendor_name_value)))::uuid;
        INSERT INTO vendors(vendor_id, vendor_name, vendor_code, country, tax_reg_number, is_active, tenant_id)
        VALUES (resolved_vendor_id, vendor_name_value, NULL, vendor_country_value, vendor_tax_value, true, NEW.tenant_id)
        ON CONFLICT (vendor_id) DO UPDATE SET vendor_name = EXCLUDED.vendor_name,
            country = EXCLUDED.country, tax_reg_number = EXCLUDED.tax_reg_number;
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

CREATE OR REPLACE FUNCTION sync_sop_extraction_log() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    job_start timestamptz;
BEGIN
    SELECT started_at INTO job_start FROM invoice_jobs WHERE id = NEW.job_id;
    INSERT INTO extraction_logs(
        log_id, invoice_id, flow_run_id, model_version, start_time, end_time,
        overall_confidence, status, tenant_id, revision, extraction_json,
        validation_json, source, created_by
    ) VALUES (
        NEW.id, NEW.job_id, NULL, NEW.engine, COALESCE(job_start, NEW.created_at), NEW.created_at,
        NEW.overall_confidence,
        CASE WHEN NEW.validation_json ->> 'reviewRequired' = 'true' THEN 'PartialSuccess' ELSE 'Success' END,
        NEW.tenant_id, NEW.revision, NEW.extraction_json, NEW.validation_json, NEW.source, NEW.created_by
    )
    ON CONFLICT (log_id) DO UPDATE SET model_version = EXCLUDED.model_version,
        end_time = EXCLUDED.end_time, overall_confidence = EXCLUDED.overall_confidence,
        status = EXCLUDED.status, extraction_json = EXCLUDED.extraction_json,
        validation_json = EXCLUDED.validation_json;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sync_sop_field_detail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO field_extraction_details(
        detail_id, log_id, field_name, extracted_value, confidence, was_overridden,
        tenant_id, value_json, value_number, value_date, source, page_number
    ) VALUES (
        NEW.id, NEW.extraction_revision_id, NEW.field_path, NEW.value_text, NEW.confidence,
        lower(COALESCE(NEW.source, '')) IN ('review', 'human_review'), NEW.tenant_id,
        NEW.value_json, NEW.value_number, NEW.value_date, NEW.source, NEW.page_number
    )
    ON CONFLICT (detail_id) DO UPDATE SET extracted_value = EXCLUDED.extracted_value,
        confidence = EXCLUDED.confidence, was_overridden = EXCLUDED.was_overridden,
        value_json = EXCLUDED.value_json, value_number = EXCLUDED.value_number,
        value_date = EXCLUDED.value_date, source = EXCLUDED.source, page_number = EXCLUDED.page_number;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sync_sop_line_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    parent_invoice_id uuid;
BEGIN
    SELECT job_id INTO parent_invoice_id FROM extraction_revisions WHERE id = NEW.extraction_revision_id;
    INSERT INTO line_items(
        line_id, invoice_id, line_number, description, quantity, unit_price, line_amount,
        charge_code, tenant_id, confidence, raw_json, source_line_item_id
    ) VALUES (
        NEW.id, parent_invoice_id,
        CASE WHEN NEW.line_number ~ '^\d+$' THEN NEW.line_number::integer ELSE NEW.line_index + 1 END,
        NEW.description, NEW.quantity, NEW.unit_price, NEW.amount, NEW.charge_code,
        NEW.tenant_id, NEW.confidence, NEW.raw_json, NEW.id
    )
    ON CONFLICT (line_id) DO UPDATE SET line_number = EXCLUDED.line_number,
        description = EXCLUDED.description, quantity = EXCLUDED.quantity,
        unit_price = EXCLUDED.unit_price, line_amount = EXCLUDED.line_amount,
        charge_code = EXCLUDED.charge_code, confidence = EXCLUDED.confidence,
        raw_json = EXCLUDED.raw_json;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sync_sop_exception() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    parent_invoice_id uuid;
BEGIN
    SELECT job_id INTO parent_invoice_id FROM extraction_revisions WHERE id = NEW.extraction_revision_id;
    INSERT INTO exception_queue(
        exception_id, invoice_id, exception_type, field_name, expected_value, actual_value,
        resolved_by, resolved_on, tenant_id, severity, message, source_validation_issue_id
    ) VALUES (
        NEW.id, parent_invoice_id,
        CASE WHEN NEW.code = 'REQUIRED' THEN 'Missing'
             WHEN NEW.code = 'LOW_CONFIDENCE' THEN 'LowConfidence' ELSE 'Mismatch' END,
        NEW.field_path, NULL, NULL, NULL, NULL, NEW.tenant_id, NEW.severity, NEW.message, NEW.id
    )
    ON CONFLICT (exception_id) DO UPDATE SET exception_type = EXCLUDED.exception_type,
        field_name = EXCLUDED.field_name, severity = EXCLUDED.severity, message = EXCLUDED.message;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sync_sop_audit_trail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO audit_trails(
        audit_id, invoice_id, action, performed_by, performed_on, from_state, to_state,
        remarks, tenant_id, batch_id, metadata, correlation_id
    ) VALUES (
        NEW.id, NEW.job_id, NEW.action, NEW.actor, NEW.created_at, NULL,
        CASE WHEN NEW.action IN ('PENDING_REVIEW', 'COMPLETED', 'REJECTED') THEN NEW.action END,
        NEW.detail, NEW.tenant_id, NEW.batch_id, NEW.metadata, NEW.correlation_id
    )
    ON CONFLICT (audit_id) DO UPDATE SET action = EXCLUDED.action,
        performed_by = EXCLUDED.performed_by, performed_on = EXCLUDED.performed_on,
        to_state = EXCLUDED.to_state, remarks = EXCLUDED.remarks,
        metadata = EXCLUDED.metadata, correlation_id = EXCLUDED.correlation_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_sop_batch_upload
AFTER INSERT OR UPDATE ON invoice_batches FOR EACH ROW EXECUTE FUNCTION sync_sop_batch_upload();
CREATE TRIGGER trg_sync_sop_invoice_header
AFTER INSERT OR UPDATE ON invoice_jobs FOR EACH ROW EXECUTE FUNCTION sync_sop_invoice_header();
CREATE TRIGGER trg_sync_sop_extraction_log
AFTER INSERT OR UPDATE ON extraction_revisions FOR EACH ROW EXECUTE FUNCTION sync_sop_extraction_log();
CREATE TRIGGER trg_sync_sop_field_detail
AFTER INSERT OR UPDATE ON extracted_fields FOR EACH ROW EXECUTE FUNCTION sync_sop_field_detail();
CREATE TRIGGER trg_sync_sop_line_item
AFTER INSERT OR UPDATE ON invoice_line_items FOR EACH ROW EXECUTE FUNCTION sync_sop_line_item();
CREATE TRIGGER trg_sync_sop_exception
AFTER INSERT OR UPDATE ON validation_issues FOR EACH ROW EXECUTE FUNCTION sync_sop_exception();
CREATE TRIGGER trg_sync_sop_audit_trail
AFTER INSERT OR UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION sync_sop_audit_trail();

-- Backfill rows created before this forward migration. The no-op updates invoke the same
-- deterministic synchronization path used for all future application writes.
UPDATE invoice_batches SET id = id;
UPDATE invoice_jobs SET id = id;
UPDATE extraction_revisions SET id = id;
UPDATE extracted_fields SET id = id;
UPDATE invoice_line_items SET id = id;
UPDATE validation_issues SET id = id;
UPDATE audit_events SET id = id;
