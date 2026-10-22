-- End-to-end latency KPI: "upload accepted -> extraction completed".
-- completed_at is overwritten when a human approves/rejects, and started_at excludes queue wait,
-- so neither can be used. The processor now stamps extraction_completed_at once, when the AI result is stored.
ALTER TABLE invoice_jobs ADD COLUMN IF NOT EXISTS extraction_completed_at timestamptz;

-- Backfill from the immutable AI revision (human revisions are source = 'HUMAN_REVIEW').
UPDATE invoice_jobs AS j
SET extraction_completed_at = (
    SELECT min(r.created_at) FROM extraction_revisions r WHERE r.job_id = j.id AND r.source = 'AI'
)
WHERE j.extraction_completed_at IS NULL;
