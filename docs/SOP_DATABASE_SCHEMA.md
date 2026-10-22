# E-Invoice Verification SOP database contract

This document records the PostgreSQL mapping of the 13-table data model in section 5.2 of the supplied E-Invoice Verification Solution Design Document. The migration is implemented in `backend/db/migrations/002_einvoice_verification_sop.sql`.

PostgreSQL identifiers use lowercase snake_case while preserving every SOP table and field. Technical columns are additions and never substitutes for the documented contract.

## Exact table and field mapping

| SOP table | PostgreSQL table | Required SOP fields |
|---|---|---|
| BATCH_UPLOADS | `batch_uploads` | `batch_id`, `batch_name`, `uploaded_by`, `uploaded_on`, `file_count`, `status` |
| INVOICE_HEADERS | `invoice_headers` | `invoice_id`, `batch_id`, `invoice_number`, `invoice_date`, `due_date`, `vendor_id`, `currency`, `total_amount`, `processing_state`, `sharepoint_path` |
| LINE_ITEMS | `line_items` | `line_id`, `invoice_id`, `line_number`, `description`, `quantity`, `unit_price`, `line_amount`, `charge_code` |
| VENDORS | `vendors` | `vendor_id`, `vendor_name`, `vendor_code`, `country`, `tax_reg_number`, `is_active` |
| AUDIT_TRAILS | `audit_trails` | `audit_id`, `invoice_id`, `action`, `performed_by`, `performed_on`, `from_state`, `to_state`, `remarks` |
| EXCEPTION_QUEUE | `exception_queue` | `exception_id`, `invoice_id`, `exception_type`, `field_name`, `expected_value`, `actual_value`, `resolved_by`, `resolved_on` |
| EXTRACTION_LOGS | `extraction_logs` | `log_id`, `invoice_id`, `flow_run_id`, `model_version`, `start_time`, `end_time`, `overall_confidence`, `status` |
| FIELD_EXTRACTION_DETAILS | `field_extraction_details` | `detail_id`, `log_id`, `field_name`, `extracted_value`, `confidence`, `was_overridden` |
| VALIDATION_RULES | `validation_rules` | `rule_id`, `rule_name`, `rule_type`, `expression`, `severity`, `is_active` |
| FILE_DETAILS | `file_details` | `file_id`, `invoice_id`, `file_name`, `sharepoint_url`, `file_size`, `mime_type` |
| GCC_INVOICE_RECORDS | `gcc_invoice_records` | `record_id`, `invoice_id`, `posting_date`, `posting_reference`, `interfaced_to` |
| GCC_PURCHASE_ORDERS | `gcc_purchase_orders` | `po_id`, `po_number`, `supplier_id`, `po_amount`, `currency`, `status` |
| GCC_SUPPLIER_RECORDS | `gcc_supplier_records` | `supplier_id`, `supplier_name`, `supplier_code`, `bank_account`, `is_blocked` |

## Choice constraints

- Batch status: `Pending`, `Processing`, `Completed`, `Failed`
- Processing state: `Draft`, `PendingExtraction`, `Extracted`, `Validating`, `PendingReview`, `Approved`, `Rejected`, `Interfaced`
- Exception type: `Mismatch`, `Missing`, `LowConfidence`
- Extraction status: `Success`, `PartialSuccess`, `Failed`
- Rule type: `ClientFlag`, `MasterMatch`, `Threshold`
- Rule severity: `Block`, `Warn`, `Info`
- Purchase-order status: `Open`, `Closed`, `Cancelled`

## Synchronization and migration behavior

The migration is forward-only and does not alter the checksum of the already-published first migration. It creates the SOP tables, seeds the five validation rules listed in the SOP, backfills existing invoice data and installs transaction-local synchronization triggers for new Node API/processor writes.

Automated tests fail if any of the 13 tables or required fields is missing. The end-to-end pipeline test also proves that an upload populates `invoice_headers`, `file_details`, `extraction_logs`, `field_extraction_details`, `line_items` and `audit_trails` while the durable processing task completes.
