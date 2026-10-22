-- Durable user cancellation. Existing completed/reviewed data remains unchanged.
ALTER TABLE invoice_batches DROP CONSTRAINT IF EXISTS invoice_batches_status_check;
ALTER TABLE invoice_batches ADD CONSTRAINT invoice_batches_status_check
  CHECK (status IN ('QUEUED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED'));
ALTER TABLE invoice_jobs DROP CONSTRAINT IF EXISTS invoice_jobs_status_check;
ALTER TABLE invoice_jobs ADD CONSTRAINT invoice_jobs_status_check
  CHECK (status IN ('QUEUED', 'PREPROCESSING', 'OCR_RUNNING', 'MAPPING', 'VALIDATING', 'PENDING_REVIEW', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED'));
ALTER TABLE processing_tasks DROP CONSTRAINT IF EXISTS processing_tasks_state_check;
ALTER TABLE processing_tasks ADD CONSTRAINT processing_tasks_state_check
  CHECK (state IN ('READY', 'LEASED', 'RETRY', 'COMPLETED', 'DEAD_LETTER', 'CANCELLED'));
