-- IES PostgreSQL schema for independently deployable Node.js API and processor services.
-- All invoice content remains private application data and is never written to Git.

CREATE TABLE tenants (
    id uuid PRIMARY KEY,
    code varchar(64) NOT NULL UNIQUE,
    display_name varchar(200) NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, code, display_name)
VALUES ('00000000-0000-4000-8000-000000000001', 'local-demo', 'Local Demo')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE invoice_batches (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    submitted_by varchar(200) NOT NULL,
    document_count integer NOT NULL CHECK (document_count BETWEEN 1 AND 100),
    status varchar(32) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS')),
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE TABLE invoice_jobs (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    batch_id uuid NOT NULL REFERENCES invoice_batches(id),
    original_filename varchar(255) NOT NULL,
    stored_filename varchar(255) NOT NULL UNIQUE,
    sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content_type varchar(100) NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    status varchar(40) NOT NULL
        CHECK (status IN ('QUEUED', 'PREPROCESSING', 'OCR_RUNNING', 'MAPPING', 'VALIDATING', 'PENDING_REVIEW', 'COMPLETED', 'FAILED', 'REJECTED')),
    overall_confidence numeric(7,6) CHECK (overall_confidence BETWEEN 0 AND 1),
    extraction_engine varchar(120),
    extraction_json jsonb,
    validation_json jsonb,
    error_code varchar(80),
    error_message varchar(1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    version bigint NOT NULL DEFAULT 0
);

CREATE INDEX idx_invoice_jobs_batch ON invoice_jobs(batch_id);
CREATE INDEX idx_invoice_jobs_tenant_created ON invoice_jobs(tenant_id, created_at DESC);
CREATE INDEX idx_invoice_jobs_tenant_status_created ON invoice_jobs(tenant_id, status, created_at DESC);
CREATE INDEX idx_invoice_jobs_tenant_sha256 ON invoice_jobs(tenant_id, sha256);
CREATE INDEX idx_invoice_jobs_extraction_gin ON invoice_jobs USING gin(extraction_json);

CREATE TABLE extraction_revisions (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    job_id uuid NOT NULL REFERENCES invoice_jobs(id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision > 0),
    extraction_json jsonb NOT NULL,
    validation_json jsonb NOT NULL,
    overall_confidence numeric(7,6) NOT NULL CHECK (overall_confidence BETWEEN 0 AND 1),
    engine varchar(120) NOT NULL,
    source varchar(32) NOT NULL CHECK (source IN ('AI', 'HUMAN_REVIEW')),
    created_by varchar(200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(job_id, revision)
);

CREATE INDEX idx_extraction_revisions_job_created ON extraction_revisions(job_id, created_at DESC);

CREATE TABLE extracted_fields (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    extraction_revision_id uuid NOT NULL REFERENCES extraction_revisions(id) ON DELETE CASCADE,
    field_path varchar(300) NOT NULL,
    value_json jsonb,
    value_text text,
    value_number numeric(24,8),
    value_date date,
    confidence numeric(7,6) CHECK (confidence BETWEEN 0 AND 1),
    source varchar(80),
    page_number integer CHECK (page_number IS NULL OR page_number > 0),
    UNIQUE(extraction_revision_id, field_path)
);

CREATE INDEX idx_extracted_fields_revision ON extracted_fields(extraction_revision_id);
CREATE INDEX idx_extracted_fields_path_text ON extracted_fields(field_path, value_text);

CREATE TABLE invoice_line_items (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    extraction_revision_id uuid NOT NULL REFERENCES extraction_revisions(id) ON DELETE CASCADE,
    line_index integer NOT NULL CHECK (line_index >= 0),
    line_number varchar(50),
    description text,
    quantity numeric(24,8),
    unit_price numeric(24,8),
    amount numeric(24,8),
    charge_code varchar(100),
    confidence numeric(7,6) CHECK (confidence BETWEEN 0 AND 1),
    raw_json jsonb NOT NULL,
    UNIQUE(extraction_revision_id, line_index)
);

CREATE INDEX idx_invoice_line_items_revision ON invoice_line_items(extraction_revision_id, line_index);

CREATE TABLE validation_issues (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    extraction_revision_id uuid NOT NULL REFERENCES extraction_revisions(id) ON DELETE CASCADE,
    field_path varchar(300) NOT NULL,
    code varchar(80) NOT NULL,
    severity varchar(16) NOT NULL CHECK (severity IN ('BLOCK', 'WARN', 'INFO')),
    message varchar(1000) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_validation_issues_revision ON validation_issues(extraction_revision_id);
CREATE INDEX idx_validation_issues_code ON validation_issues(code, severity);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    job_id uuid REFERENCES invoice_jobs(id) ON DELETE CASCADE,
    batch_id uuid REFERENCES invoice_batches(id) ON DELETE CASCADE,
    action varchar(80) NOT NULL,
    actor varchar(200) NOT NULL,
    detail varchar(1000),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    correlation_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (job_id IS NOT NULL OR batch_id IS NOT NULL)
);

CREATE INDEX idx_audit_job_created ON audit_events(job_id, created_at);
CREATE INDEX idx_audit_batch_created ON audit_events(batch_id, created_at);
CREATE INDEX idx_audit_tenant_created ON audit_events(tenant_id, created_at DESC);

CREATE TABLE processing_tasks (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    job_id uuid NOT NULL UNIQUE REFERENCES invoice_jobs(id) ON DELETE CASCADE,
    state varchar(24) NOT NULL DEFAULT 'READY'
        CHECK (state IN ('READY', 'LEASED', 'RETRY', 'COMPLETED', 'DEAD_LETTER')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    available_at timestamptz NOT NULL DEFAULT now(),
    leased_by varchar(160),
    lease_expires_at timestamptz,
    last_error_code varchar(80),
    last_error_message varchar(1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_processing_tasks_claim ON processing_tasks(state, available_at, created_at)
    WHERE state IN ('READY', 'RETRY');
CREATE INDEX idx_processing_tasks_expired_lease ON processing_tasks(lease_expires_at)
    WHERE state = 'LEASED';

CREATE TABLE benchmark_runs (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    dataset_name varchar(200) NOT NULL,
    dataset_fingerprint char(64) NOT NULL CHECK (dataset_fingerprint ~ '^[0-9a-f]{64}$'),
    model_name varchar(200) NOT NULL,
    model_configuration jsonb NOT NULL,
    status varchar(24) NOT NULL CHECK (status IN ('RUNNING', 'PASSED', 'FAILED', 'CANCELLED')),
    field_accuracy numeric(7,6) CHECK (field_accuracy BETWEEN 0 AND 1),
    critical_field_accuracy numeric(7,6) CHECK (critical_field_accuracy BETWEEN 0 AND 1),
    line_item_f1 numeric(7,6) CHECK (line_item_f1 BETWEEN 0 AND 1),
    p95_latency_ms integer CHECK (p95_latency_ms IS NULL OR p95_latency_ms >= 0),
    invoices_per_hour numeric(12,3) CHECK (invoices_per_hour IS NULL OR invoices_per_hour >= 0),
    representative_holdout boolean NOT NULL DEFAULT false,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    created_by varchar(200) NOT NULL
);

CREATE INDEX idx_benchmark_runs_tenant_started ON benchmark_runs(tenant_id, started_at DESC);

CREATE TABLE benchmark_document_results (
    id uuid PRIMARY KEY,
    benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    document_key varchar(200) NOT NULL,
    quality_band varchar(80),
    layout_family varchar(120),
    passed boolean NOT NULL,
    field_accuracy numeric(7,6) NOT NULL CHECK (field_accuracy BETWEEN 0 AND 1),
    critical_field_accuracy numeric(7,6) NOT NULL CHECK (critical_field_accuracy BETWEEN 0 AND 1),
    line_item_f1 numeric(7,6) NOT NULL CHECK (line_item_f1 BETWEEN 0 AND 1),
    latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    error_code varchar(80),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(benchmark_run_id, document_key)
);

CREATE INDEX idx_benchmark_document_run ON benchmark_document_results(benchmark_run_id);

CREATE TABLE benchmark_field_results (
    id uuid PRIMARY KEY,
    benchmark_document_result_id uuid NOT NULL REFERENCES benchmark_document_results(id) ON DELETE CASCADE,
    field_path varchar(300) NOT NULL,
    expected_hash char(64),
    actual_hash char(64),
    matched boolean NOT NULL,
    normalization varchar(80) NOT NULL,
    UNIQUE(benchmark_document_result_id, field_path)
);

CREATE INDEX idx_benchmark_field_document ON benchmark_field_results(benchmark_document_result_id);

CREATE VIEW release_accuracy_status AS
SELECT
    id AS benchmark_run_id,
    dataset_name,
    model_name,
    field_accuracy,
    critical_field_accuracy,
    line_item_f1,
    p95_latency_ms,
    invoices_per_hour,
    representative_holdout,
    (representative_holdout
        AND field_accuracy >= 0.95
        AND critical_field_accuracy >= 0.98
        AND p95_latency_ms < 15000
        AND invoices_per_hour >= 200) AS release_approved,
    completed_at
FROM benchmark_runs
WHERE status IN ('PASSED', 'FAILED');
