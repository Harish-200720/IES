import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { Readable } from 'node:stream'

import type { QueryResultRow } from 'pg'

import type { Config } from './config.js'
import type { Database } from './db/pool.js'
import { ApiError } from './shared/errors.js'
import { storagePath } from './storage.js'

const MAX_ZIP32_BYTES = 0xffff_ffff
const ZIP_FLAGS = 0x0808 // UTF-8 names and a trailing data descriptor.

interface InvoiceAuditRow extends QueryResultRow {
  id: string
  batchId: string
  filename: string
  storedFilename: string
  sha256: string
  contentType: string
  sizeBytes: string | number
  status: string
  confidence: number | null
  engine: string | null
  extraction: Record<string, unknown> | null
  validation: unknown
  ocrEvidence: unknown
  errorCode: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  completedAt: Date | null
}

interface RevisionRow extends QueryResultRow {
  jobId: string
  revision: number
  extraction: Record<string, unknown>
  validation: unknown
  confidence: number
  engine: string
  source: string
  createdBy: string
  createdAt: Date
}

interface EventRow extends QueryResultRow {
  id: string
  jobId: string | null
  batchId: string | null
  action: string
  actor: string
  detail: string | null
  metadata: unknown
  correlationId: string | null
  createdAt: Date
}

interface ZipEntry {
  name: string
  modifiedAt: Date
  data: Buffer | { path: string; size: number }
}

export interface AuditArchive {
  filename: string
  stream: Readable
}

interface FlatField {
  section: string
  path: string
  name: string
  value: unknown
  confidence: number | null
  source: string | null
  page: number | null
  evidence: unknown
}

const INVOICE_COLUMNS = `
  id,
  batch_id AS "batchId",
  original_filename AS filename,
  stored_filename AS "storedFilename",
  sha256,
  content_type AS "contentType",
  size_bytes AS "sizeBytes",
  status,
  overall_confidence::double precision AS confidence,
  extraction_engine AS engine,
  extraction_json AS extraction,
  validation_json AS validation,
  ocr_evidence_json AS "ocrEvidence",
  error_code AS "errorCode",
  error_message AS error,
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  started_at AS "startedAt",
  completed_at AS "completedAt"
`

function safeArchiveSegment(value: string, fallback: string): string {
  const cleaned = basename(value).replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\s+/g, ' ').trim()
  return (cleaned || fallback).slice(0, 180)
}

function packageStem(filename: string): string {
  const extension = extname(filename)
  return safeArchiveSegment(filename.slice(0, extension ? -extension.length : undefined), 'invoice')
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function isExtractedField(value: unknown): value is Record<string, unknown> & { value: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'value' in value
}

function flattenFields(value: unknown, path: string[] = [], output: FlatField[] = []): FlatField[] {
  if (isExtractedField(value)) {
    const { value: extractedValue, confidence, source, page, ...evidence } = value
    output.push({
      section: path[0] ?? 'additional',
      path: path.join('.'),
      name: path.at(-1) ?? 'field',
      value: extractedValue,
      confidence: typeof confidence === 'number' ? confidence : null,
      source: typeof source === 'string' ? source : null,
      page: typeof page === 'number' ? page : null,
      evidence: Object.keys(evidence).length ? evidence : null,
    })
    return output
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenFields(entry, [...path, String(index)], output))
    return output
  }
  if (typeof value === 'object' && value !== null) {
    Object.entries(value).forEach(([key, nested]) => flattenFields(nested, [...path, key], output))
  }
  return output
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  // Prevent formula execution when a reviewer opens the export in spreadsheet software.
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

function fieldsCsv(fields: FlatField[]): Buffer {
  const headers = ['section', 'field_path', 'field_name', 'extracted_value', 'confidence', 'source', 'page', 'evidence']
  const rows = fields.map((field) => [field.section, field.path, field.name, field.value, field.confidence, field.source, field.page, field.evidence])
  return Buffer.from(`\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8')
}

function reviewTemplate(job: InvoiceAuditRow, fields: FlatField[]) {
  return {
    schemaVersion: 'ies.audit-review.v1',
    instructions: 'For each reviewed field, set outcome to CORRECT, INCORRECT or NOT_APPLICABLE. For incorrect fields, provide correctedValue and optional notes. Do not alter extractedValue.',
    jobId: job.id,
    batchId: job.batchId,
    sourceFilename: job.filename,
    reviewStatus: 'UNREVIEWED',
    reviewer: '',
    reviewedAt: null,
    overallNotes: '',
    fieldReviews: fields.map((field) => ({
      fieldPath: field.path,
      extractedValue: field.value,
      outcome: 'UNREVIEWED',
      correctedValue: null,
      notes: '',
    })),
  }
}

function invoiceManifest(job: InvoiceAuditRow, generatedAt: Date, prefix: string) {
  return {
    schemaVersion: 'ies.audit.v1',
    packageType: 'INVOICE',
    generatedAt: generatedAt.toISOString(),
    invoice: {
      jobId: job.id,
      batchId: job.batchId,
      sourceFilename: job.filename,
      sourceSha256: job.sha256,
      sourceContentType: job.contentType,
      sourceSizeBytes: Number(job.sizeBytes),
      status: job.status,
      overallConfidence: job.confidence,
      extractionEngine: job.engine,
      errorCode: job.errorCode,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    },
    files: {
      sourceInvoice: `${prefix}source/${safeArchiveSegment(job.filename, 'invoice')}`,
      extractedFieldsJson: `${prefix}extracted-fields.json`,
      extractedFieldsCsv: `${prefix}extracted-fields.csv`,
      validation: `${prefix}validation.json`,
      ocrEvidence: `${prefix}ocr-evidence.json`,
      revisions: `${prefix}extraction-revisions.json`,
      auditTrail: `${prefix}audit-events.json`,
      reviewTemplate: `${prefix}review-template.json`,
    },
  }
}

async function validateSource(config: Config, job: InvoiceAuditRow): Promise<{ path: string; size: number }> {
  const path = storagePath(config, job.storedFilename)
  try {
    const source = await stat(path)
    if (!source.isFile()) throw new ApiError(404, `Source invoice is unavailable for ${job.filename}`, 'SOURCE_NOT_FOUND')
    if (source.size > MAX_ZIP32_BYTES) throw new ApiError(413, 'Source invoice is too large for an audit package', 'AUDIT_PACKAGE_TOO_LARGE')
    return { path, size: source.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ApiError(404, `Source invoice is unavailable for ${job.filename}`, 'SOURCE_NOT_FOUND')
    }
    throw error
  }
}

function invoiceEntries(
  job: InvoiceAuditRow,
  source: { path: string; size: number },
  revisions: RevisionRow[],
  events: EventRow[],
  generatedAt: Date,
  prefix = '',
): ZipEntry[] {
  const fields = flattenFields(job.extraction)
  const modifiedAt = job.updatedAt
  return [
    { name: `${prefix}manifest.json`, modifiedAt: generatedAt, data: json(invoiceManifest(job, generatedAt, prefix)) },
    { name: `${prefix}source/${safeArchiveSegment(job.filename, 'invoice')}`, modifiedAt: job.createdAt, data: source },
    { name: `${prefix}extracted-fields.json`, modifiedAt, data: json(job.extraction) },
    { name: `${prefix}extracted-fields.csv`, modifiedAt, data: fieldsCsv(fields) },
    { name: `${prefix}validation.json`, modifiedAt, data: json(job.validation) },
    { name: `${prefix}ocr-evidence.json`, modifiedAt, data: json(job.ocrEvidence) },
    { name: `${prefix}extraction-revisions.json`, modifiedAt, data: json(revisions) },
    { name: `${prefix}audit-events.json`, modifiedAt: generatedAt, data: json(events) },
    { name: `${prefix}review-template.json`, modifiedAt: generatedAt, data: json(reviewTemplate(job, fields)) },
  ]
}

const README = `IES extraction audit package\n\nThis private package contains the retained source invoice, exact extracted fields, page-level OCR text/confidence evidence, validation results, extraction revisions and audit events.\n\nFor structured review, edit review-template.json. Mark each reviewed field CORRECT, INCORRECT or NOT_APPLICABLE; provide correctedValue for incorrect fields. Keep the original source and extracted values unchanged so results can be compared reliably.\n\nTreat this package as confidential because it may contain invoice and supplier information.\n`

async function revisionsForInvoice(database: Database, tenantId: string, jobId: string): Promise<RevisionRow[]> {
  const result = await database.query<RevisionRow>(
    `SELECT job_id AS "jobId", revision, extraction_json AS extraction, validation_json AS validation,
            overall_confidence::double precision AS confidence, engine, source, created_by AS "createdBy", created_at AS "createdAt"
       FROM extraction_revisions WHERE tenant_id = $1 AND job_id = $2 ORDER BY revision ASC`,
    [tenantId, jobId],
  )
  return result.rows
}

async function eventsForInvoice(database: Database, tenantId: string, jobId: string): Promise<EventRow[]> {
  const result = await database.query<EventRow>(
    `SELECT id, job_id AS "jobId", batch_id AS "batchId", action, actor, detail, metadata,
            correlation_id AS "correlationId", created_at AS "createdAt"
       FROM audit_events WHERE tenant_id = $1 AND job_id = $2 ORDER BY created_at ASC`,
    [tenantId, jobId],
  )
  return result.rows
}

export async function createInvoiceAuditArchive(
  config: Config,
  database: Database,
  tenantId: string,
  jobId: string,
): Promise<AuditArchive> {
  const result = await database.query<InvoiceAuditRow>(
    `SELECT ${INVOICE_COLUMNS} FROM invoice_jobs WHERE tenant_id = $1 AND id = $2`,
    [tenantId, jobId],
  )
  const job = result.rows[0]
  if (!job) throw new ApiError(404, 'Invoice not found', 'NOT_FOUND')
  const [source, revisions, events] = await Promise.all([
    validateSource(config, job),
    revisionsForInvoice(database, tenantId, jobId),
    eventsForInvoice(database, tenantId, jobId),
  ])
  const generatedAt = new Date()
  const entries = [
    { name: 'README.txt', modifiedAt: generatedAt, data: Buffer.from(README, 'utf8') },
    ...invoiceEntries(job, source, revisions, events, generatedAt),
  ]
  return {
    filename: `${packageStem(job.filename)}-${job.id.slice(0, 8)}-audit.zip`,
    stream: zipStream(entries),
  }
}

export async function createBatchAuditArchive(
  config: Config,
  database: Database,
  tenantId: string,
  batchId: string,
): Promise<AuditArchive> {
  const batchResult = await database.query<{
    id: string; submittedBy: string; documentCount: number; status: string; createdAt: Date; completedAt: Date | null
  }>(
    `SELECT id, submitted_by AS "submittedBy", document_count AS "documentCount", status,
            created_at AS "createdAt", completed_at AS "completedAt"
       FROM invoice_batches WHERE tenant_id = $1 AND id = $2`,
    [tenantId, batchId],
  )
  const batch = batchResult.rows[0]
  if (!batch) throw new ApiError(404, 'Invoice batch not found', 'NOT_FOUND')
  const jobsResult = await database.query<InvoiceAuditRow>(
    `SELECT ${INVOICE_COLUMNS} FROM invoice_jobs WHERE tenant_id = $1 AND batch_id = $2 ORDER BY created_at ASC, id ASC`,
    [tenantId, batchId],
  )
  const jobs = jobsResult.rows
  const sources = await Promise.all(jobs.map((job) => validateSource(config, job)))
  const generatedAt = new Date()
  const entries: ZipEntry[] = [
    { name: 'README.txt', modifiedAt: generatedAt, data: Buffer.from(README, 'utf8') },
    { name: 'manifest.json', modifiedAt: generatedAt, data: json({
      schemaVersion: 'ies.audit.v1',
      packageType: 'BATCH',
      generatedAt,
      batch: {
        batchId: batch.id,
        submittedBy: batch.submittedBy,
        declaredDocumentCount: Number(batch.documentCount),
        packagedDocumentCount: jobs.length,
        status: batch.status,
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
      },
      invoices: jobs.map((job, index) => ({
        jobId: job.id,
        filename: job.filename,
        status: job.status,
        overallConfidence: job.confidence,
        folder: `invoices/${String(index + 1).padStart(3, '0')}-${job.id}/`,
      })),
    }) },
  ]
  for (const [index, job] of jobs.entries()) {
    const prefix = `invoices/${String(index + 1).padStart(3, '0')}-${job.id}/`
    const [revisions, events] = await Promise.all([
      revisionsForInvoice(database, tenantId, job.id),
      eventsForInvoice(database, tenantId, job.id),
    ])
    entries.push(...invoiceEntries(job, sources[index]!, revisions, events, generatedAt, prefix))
  }
  const batchEvents = await database.query<EventRow>(
    `SELECT id, job_id AS "jobId", batch_id AS "batchId", action, actor, detail, metadata,
            correlation_id AS "correlationId", created_at AS "createdAt"
       FROM audit_events WHERE tenant_id = $1 AND batch_id = $2 ORDER BY created_at ASC`,
    [tenantId, batchId],
  )
  entries.push({ name: 'batch-audit-events.json', modifiedAt: generatedAt, data: json(batchEvents.rows) })
  return { filename: `batch-${batchId}-audit.zip`, stream: zipStream(entries) }
}

const CRC_TABLE = new Uint32Array(256).map((_value, index) => {
  let current = index
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? (0xedb8_8320 ^ (current >>> 1)) : (current >>> 1)
  return current >>> 0
})

function crcUpdate(crc: number, chunk: Buffer): number {
  let current = crc
  for (const byte of chunk) current = (CRC_TABLE[(current ^ byte) & 0xff]! ^ (current >>> 8)) >>> 0
  return current
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

function localHeader(name: Buffer, modifiedAt: Date): Buffer {
  const { date, time } = dosDateTime(modifiedAt)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x0403_4b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(ZIP_FLAGS, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  header.writeUInt16LE(name.length, 26)
  return header
}

function centralHeader(name: Buffer, modifiedAt: Date, crc: number, size: number, offset: number): Buffer {
  const { date, time } = dosDateTime(modifiedAt)
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x0201_4b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(ZIP_FLAGS, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(time, 12)
  header.writeUInt16LE(date, 14)
  header.writeUInt32LE(crc >>> 0, 16)
  header.writeUInt32LE(size, 20)
  header.writeUInt32LE(size, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt32LE(offset, 42)
  return header
}

function zipStream(entries: ZipEntry[]): Readable {
  return Readable.from((async function* () {
    if (entries.length > 0xffff) throw new ApiError(413, 'Audit package contains too many files', 'AUDIT_PACKAGE_TOO_LARGE')
    const centralRecords: Buffer[] = []
    let offset = 0
    for (const entry of entries) {
      const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8')
      if (!name.length || name.length > 0xffff) throw new ApiError(500, 'Invalid audit archive entry name', 'AUDIT_ARCHIVE_ERROR')
      const expectedSize = Buffer.isBuffer(entry.data) ? entry.data.length : entry.data.size
      if (expectedSize > MAX_ZIP32_BYTES || offset + expectedSize > MAX_ZIP32_BYTES) {
        throw new ApiError(413, 'Audit package exceeds the ZIP32 size limit', 'AUDIT_PACKAGE_TOO_LARGE')
      }
      const entryOffset = offset
      const header = localHeader(name, entry.modifiedAt)
      yield header
      yield name
      offset += header.length + name.length
      let crc = 0xffff_ffff
      let actualSize = 0
      const chunks: AsyncIterable<Buffer> = Buffer.isBuffer(entry.data)
        ? Readable.from([entry.data])
        : createReadStream(entry.data.path)
      for await (const rawChunk of chunks) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
        crc = crcUpdate(crc, chunk)
        actualSize += chunk.length
        yield chunk
      }
      if (actualSize !== expectedSize) throw new ApiError(409, 'Source invoice changed while its audit package was generated', 'SOURCE_CHANGED')
      const finalizedCrc = (crc ^ 0xffff_ffff) >>> 0
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x0807_4b50, 0)
      descriptor.writeUInt32LE(finalizedCrc, 4)
      descriptor.writeUInt32LE(actualSize, 8)
      descriptor.writeUInt32LE(actualSize, 12)
      yield descriptor
      offset += actualSize + descriptor.length
      centralRecords.push(Buffer.concat([centralHeader(name, entry.modifiedAt, finalizedCrc, actualSize, entryOffset), name]))
    }
    const centralOffset = offset
    for (const record of centralRecords) {
      yield record
      offset += record.length
    }
    const centralSize = offset - centralOffset
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x0605_4b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralOffset, 16)
    yield end
  })())
}
