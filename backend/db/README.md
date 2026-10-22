# PostgreSQL schema

The Node API and processor run all pending migrations under a PostgreSQL advisory lock at startup; `pnpm migrate` is also available for deployment jobs. Migration `002_einvoice_verification_sop.sql` is the canonical PostgreSQL implementation of section 5.2 in the E-Invoice Verification SOP.

## Tables

| SOP section | Canonical PostgreSQL table |
|---|---|
| 5.2.1 Invoice Batch Uploads | `batch_uploads` |
| 5.2.2 Invoice Headers | `invoice_headers` |
| 5.2.3 Invoice Line Items | `line_items` |
| 5.2.4 Invoice Vendors | `vendors` |
| 5.2.5 Invoice Audit Trails | `audit_trails` |
| 5.2.6 Invoice Exception Queue | `exception_queue` |
| 5.2.7 Invoice Extraction Logs | `extraction_logs` |
| 5.2.8 Field Extraction Details | `field_extraction_details` |
| 5.2.9 Invoice Validation Rules | `validation_rules` |
| 5.2.10 Invoice File Details | `file_details` |
| 5.2.11 GCC Invoice Records | `gcc_invoice_records` |
| 5.2.12 GCC Purchase Orders | `gcc_purchase_orders` |
| 5.2.13 GCC Supplier Records | `gcc_supplier_records` |

PostgreSQL folds the SOP's uppercase logical names to lowercase. Column names use the same lossless snake_case mapping: for example, `InvoiceId` becomes `invoice_id` and `TaxRegNumber` becomes `tax_reg_number`.

## Technical extensions

The original Node tables remain internal transaction/compatibility tables while the forward migration preserves existing data and synchronizes every write into the canonical SOP tables. `tenants`, `processing_tasks`, `benchmark_runs`, `benchmark_document_results`, and `benchmark_field_results` are justified extensions for tenant isolation, durable microservice processing and measured release evidence. They do not replace or omit any SOP entity.

`release_accuracy_status` reports whether a completed representative holdout run has met the configured scalar-field accuracy, critical-field accuracy, line-item F1, p95 latency and throughput gates. A synthetic or incomplete run cannot pass the release gate.

## Operational behavior

- Upload metadata, the initial audit event and the processing task are committed atomically and mirrored into the SOP business schema in the same database transaction.
- Processors lease work with `FOR UPDATE SKIP LOCKED`, renew ownership by lease timestamp and recover expired leases after a crash.
- Extraction revisions are immutable snapshots; the active revision is referenced by the invoice job.
- Scalar fields and line items are normalized for reporting while the versioned JSON payload is retained for complete replay.
- Tenant keys, foreign keys, checks and queue indexes are defined in the migration rather than application-only code.

Run `pnpm verify` to execute the migration and full pipeline against an embedded PostgreSQL-compatible engine. For a deployed PostgreSQL database, set `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USERNAME` and `DATABASE_PASSWORD`, then run `pnpm migrate`.
