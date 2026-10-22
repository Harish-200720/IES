import type { QueryResultRow } from 'pg'

import type { ValidationResult } from '../domain/types.js'
import { id } from '../shared/ids.js'
import type { DatabaseClient } from './pool.js'

export const JOB_COLUMNS = `
  id,
  batch_id AS "batchId",
  (SELECT status FROM invoice_batches WHERE invoice_batches.id = invoice_jobs.batch_id) AS "batchStatus",
  original_filename AS filename,
  status,
  size_bytes AS "sizeBytes",
  overall_confidence::double precision AS confidence,
  extraction_engine AS engine,
  extraction_json AS extraction,
  validation_json AS validation,
  error_message AS error,
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  CASE WHEN extraction_completed_at IS NOT NULL
    THEN floor(extract(epoch FROM (extraction_completed_at - created_at)) * 1000)::bigint
    ELSE NULL END AS "latencyMs"
`

export interface JobResponse extends QueryResultRow {
  id: string
  batchId: string
  batchStatus: string
  filename: string
  status: string
  sizeBytes: string | number
  confidence: number | null
  engine: string | null
  extraction: Record<string, unknown> | null
  validation: ValidationResult | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  latencyMs: string | number | null
}

export async function getJob(client: DatabaseClient, tenantId: string, jobId: string, lock = false): Promise<JobResponse | undefined> {
  const result = await client.query<JobResponse>(
    `SELECT ${JOB_COLUMNS} FROM invoice_jobs WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, jobId],
  )
  return result.rows[0]
}

export async function audit(
  client: DatabaseClient,
  input: { tenantId: string; jobId?: string; batchId?: string; action: string; actor: string; detail?: string; metadata?: unknown; correlationId?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(id, tenant_id, job_id, batch_id, action, actor, detail, metadata, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [id(), input.tenantId, input.jobId ?? null, input.batchId ?? null, input.action, input.actor,
      input.detail?.slice(0, 1000) ?? null, JSON.stringify(input.metadata ?? {}), input.correlationId ?? null],
  )
}

function isField(value: unknown): value is { value: unknown; confidence?: number; source?: string; page?: number | null } {
  return typeof value === 'object' && value !== null && 'value' in value
}

function scalarFields(value: unknown, path = '', output: Array<[string, { value: unknown; confidence?: number; source?: string; page?: number | null }]> = []) {
  if (isField(value)) {
    output.push([path, value])
    return output
  }
  if (Array.isArray(value)) return output
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) scalarFields(nested, path ? `${path}.${key}` : key, output)
  }
  return output
}

function fieldValue(value: unknown): unknown {
  return isField(value) ? value.value : value
}

function fieldConfidence(value: unknown): number | undefined {
  return isField(value) && typeof value.confidence === 'number' ? value.confidence : undefined
}

function numberValue(value: unknown): number | null {
  const unwrapped = fieldValue(value)
  if (unwrapped === null || unwrapped === undefined || unwrapped === '') return null
  const numeric = Number(unwrapped)
  return Number.isFinite(numeric) ? numeric : null
}

export async function persistExtraction(
  client: DatabaseClient,
  input: {
    tenantId: string
    jobId: string
    invoice: Record<string, unknown>
    validation: ValidationResult
    confidence: number
    engine: string
    source: 'AI' | 'HUMAN_REVIEW'
    actor: string
  },
): Promise<string> {
  const revisionId = id()
  const revisionResult = await client.query<{ revision: number }>(
    'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM extraction_revisions WHERE job_id = $1',
    [input.jobId],
  )
  const revision = Number(revisionResult.rows[0]?.revision ?? 1)
  await client.query(
    `INSERT INTO extraction_revisions
       (id, tenant_id, job_id, revision, extraction_json, validation_json, overall_confidence, engine, source, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
    [revisionId, input.tenantId, input.jobId, revision, JSON.stringify(input.invoice), JSON.stringify(input.validation),
      input.confidence, input.engine, input.source, input.actor],
  )

  for (const [path, field] of scalarFields(input.invoice)) {
    const raw = field.value
    const asText = raw === null || raw === undefined ? null : String(raw)
    const asNumber = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    const asDate = /date/i.test(path) && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
    await client.query(
      `INSERT INTO extracted_fields
         (id, tenant_id, extraction_revision_id, field_path, value_json, value_text, value_number, value_date, confidence, source, page_number)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [id(), input.tenantId, revisionId, path, JSON.stringify(raw ?? null), asText, asNumber, asDate,
        field.confidence ?? null, field.source ?? null, field.page ?? null],
    )
  }

  const lines = Array.isArray(input.invoice.lineItems) ? input.invoice.lineItems : []
  for (const [index, entry] of lines.entries()) {
    const line = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
    const confidences = Object.values(line).map(fieldConfidence).filter((value): value is number => value !== undefined)
    const confidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null
    await client.query(
      `INSERT INTO invoice_line_items
         (id, tenant_id, extraction_revision_id, line_index, line_number, description, quantity, unit_price, amount, charge_code, confidence, raw_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [id(), input.tenantId, revisionId, index, fieldValue(line.lineNumber) ?? null, fieldValue(line.description) ?? null,
        numberValue(line.quantity), numberValue(line.unitPrice), numberValue(line.amount), fieldValue(line.chargeCode) ?? null,
        confidence, JSON.stringify(line)],
    )
  }

  for (const validationIssue of input.validation.issues) {
    await client.query(
      `INSERT INTO validation_issues(id, tenant_id, extraction_revision_id, field_path, code, severity, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id(), input.tenantId, revisionId, validationIssue.field, validationIssue.code, validationIssue.severity,
        validationIssue.message.slice(0, 1000)],
    )
  }
  return revisionId
}
