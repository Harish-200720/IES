import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const database = new PGlite()

beforeAll(async () => {
  const directory = resolve('db/migrations')
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    await database.exec(await readFile(resolve(directory, file), 'utf8'))
  }
})

afterAll(async () => database.close())

describe('PostgreSQL schema', () => {
  it('creates every application table and the release gate view', async () => {
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
      'audit_trails',
      'audit_events',
      'batch_uploads',
      'benchmark_document_results',
      'benchmark_field_results',
      'benchmark_runs',
      'exception_queue',
      'extracted_fields',
      'extraction_logs',
      'extraction_revisions',
      'field_extraction_details',
      'file_details',
      'gcc_invoice_records',
      'gcc_purchase_orders',
      'gcc_supplier_records',
      'invoice_batches',
      'invoice_headers',
      'invoice_jobs',
      'invoice_line_items',
      'line_items',
      'processing_tasks',
      'tenants',
      'validation_rules',
      'validation_issues',
      'vendors',
    ]))
    const view = await database.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.views WHERE table_name = 'release_accuracy_status'",
    )
    expect(view.rows).toHaveLength(1)
  })

  it('contains every field defined by the E-Invoice Verification SOP', async () => {
    const expected: Record<string, string[]> = {
      batch_uploads: ['batch_id', 'batch_name', 'uploaded_by', 'uploaded_on', 'file_count', 'status'],
      invoice_headers: ['invoice_id', 'batch_id', 'invoice_number', 'invoice_date', 'due_date', 'vendor_id',
        'currency', 'total_amount', 'processing_state', 'sharepoint_path'],
      line_items: ['line_id', 'invoice_id', 'line_number', 'description', 'quantity', 'unit_price',
        'line_amount', 'charge_code'],
      vendors: ['vendor_id', 'vendor_name', 'vendor_code', 'country', 'tax_reg_number', 'is_active'],
      audit_trails: ['audit_id', 'invoice_id', 'action', 'performed_by', 'performed_on', 'from_state',
        'to_state', 'remarks'],
      exception_queue: ['exception_id', 'invoice_id', 'exception_type', 'field_name', 'expected_value',
        'actual_value', 'resolved_by', 'resolved_on'],
      extraction_logs: ['log_id', 'invoice_id', 'flow_run_id', 'model_version', 'start_time', 'end_time',
        'overall_confidence', 'status'],
      field_extraction_details: ['detail_id', 'log_id', 'field_name', 'extracted_value', 'confidence',
        'was_overridden'],
      validation_rules: ['rule_id', 'rule_name', 'rule_type', 'expression', 'severity', 'is_active'],
      file_details: ['file_id', 'invoice_id', 'file_name', 'sharepoint_url', 'file_size', 'mime_type'],
      gcc_invoice_records: ['record_id', 'invoice_id', 'posting_date', 'posting_reference', 'interfaced_to'],
      gcc_purchase_orders: ['po_id', 'po_number', 'supplier_id', 'po_amount', 'currency', 'status'],
      gcc_supplier_records: ['supplier_id', 'supplier_name', 'supplier_code', 'bank_account', 'is_blocked'],
    }
    for (const [table, columns] of Object.entries(expected)) {
      const result = await database.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      )
      expect(result.rows.map((row) => row.column_name), table).toEqual(expect.arrayContaining(columns))
    }
  })

  it('enforces job confidence and status constraints', async () => {
    await database.exec(`
      INSERT INTO invoice_batches(id, tenant_id, submitted_by, document_count)
      VALUES ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'test', 1)
    `)
    await expect(database.exec(`
      INSERT INTO invoice_jobs(
        id, tenant_id, batch_id, original_filename, stored_filename, sha256,
        content_type, size_bytes, status, overall_confidence
      ) VALUES (
        '20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001', 'invoice.pdf', 'stored.pdf',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'application/pdf', 100, 'QUEUED', 1.1
      )
    `)).rejects.toThrow()
  })

  it('retains page-level OCR evidence for audit analysis', async () => {
    const result = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'invoice_jobs' AND column_name = 'ocr_evidence_json'`,
    )
    expect(result.rows).toHaveLength(1)
  })

  it('enforces SOP processing-state choices', async () => {
    await expect(database.exec(`
      INSERT INTO invoice_headers(
        invoice_id, batch_id, processing_state, tenant_id, source_job_status
      ) VALUES (
        '20000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001', 'UnknownState',
        '00000000-0000-4000-8000-000000000001', 'QUEUED'
      )
    `)).rejects.toThrow()
  })

  it('rejects release approval without a representative holdout', async () => {
    await database.exec(`
      INSERT INTO benchmark_runs(
        id, tenant_id, dataset_name, dataset_fingerprint, model_name, model_configuration,
        status, field_accuracy, critical_field_accuracy, line_item_f1, p95_latency_ms,
        invoices_per_hour, representative_holdout, completed_at, created_by
      ) VALUES (
        '30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
        'synthetic', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'qwen-test', '{}', 'PASSED', 0.99, 0.99, 0.99, 1000, 1000, false, now(), 'test'
      )
    `)
    const result = await database.query<{ release_approved: boolean }>(
      "SELECT release_approved FROM release_accuracy_status WHERE benchmark_run_id = '30000000-0000-4000-8000-000000000001'",
    )
    expect(result.rows[0]?.release_approved).toBe(false)
  })
})
