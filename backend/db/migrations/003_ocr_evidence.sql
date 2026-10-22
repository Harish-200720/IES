-- Retain page-level OCR evidence so audit reviews can distinguish recognition from mapping errors.
ALTER TABLE invoice_jobs
    ADD COLUMN IF NOT EXISTS ocr_evidence_json jsonb;

