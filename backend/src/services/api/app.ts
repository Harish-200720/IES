import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { collectDefaultMetrics, Counter, Registry } from 'prom-client'
import { z } from 'zod'

import { createBatchAuditArchive, createInvoiceAuditArchive } from '../../audit-package.js'
import { AuthService } from '../../auth.js'
import { LOCAL_TENANT_ID, type Config } from '../../config.js'
import { audit, getJob, JOB_COLUMNS, persistExtraction, type JobResponse } from '../../db/repository.js'
import { transaction, type Database } from '../../db/pool.js'
import { overallConfidence } from '../../domain/confidence.js'
import { JOB_STATUSES } from '../../domain/types.js'
import { validateInvoice } from '../../domain/validation.js'
import { ApiError } from '../../shared/errors.js'
import { id } from '../../shared/ids.js'
import { invoiceContentType, removeStored, storagePath, storeUpload, type StoredUpload } from '../../storage.js'

const reviewSchema = z.object({
  extraction: z.record(z.string(), z.unknown()),
  approved: z.boolean(),
  remarks: z.string().max(1000).default(''),
})
const uuidSchema = z.uuid()

function publicJob(job: JobResponse) {
  return {
    ...job,
    sizeBytes: Number(job.sizeBytes),
    latencyMs: job.latencyMs === null ? null : Number(job.latencyMs),
  }
}

function fileCleanup(files: StoredUpload[]) {
  return Promise.all(files.map((file) => removeStored(file.path)))
}

function encodedDownloadFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function sendAuditArchive(reply: FastifyReply, archive: { filename: string; stream: NodeJS.ReadableStream }) {
  reply.header('content-type', 'application/zip')
  reply.header('content-disposition', `attachment; filename*=UTF-8''${encodedDownloadFilename(archive.filename)}`)
  reply.header('cache-control', 'private, no-store')
  reply.header('content-security-policy', "default-src 'none'; sandbox")
  return reply.send(archive.stream)
}

const cancellableJobStatuses = ['QUEUED', 'PREPROCESSING', 'OCR_RUNNING', 'MAPPING', 'VALIDATING'] as const

async function cancelJob(client: import('../../db/pool.js').DatabaseClient, jobId: string, actor: string) {
  const job = await client.query<{ id: string; batchId: string; status: string }>(
    `SELECT id, batch_id AS "batchId", status FROM invoice_jobs
     WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [LOCAL_TENANT_ID, jobId],
  )
  const current = job.rows[0]
  if (!current) throw new ApiError(404, 'Invoice not found', 'NOT_FOUND')
  if (!cancellableJobStatuses.includes(current.status as typeof cancellableJobStatuses[number])) {
    throw new ApiError(409, `Invoice cannot be cancelled from ${current.status}`, 'INVALID_STATE')
  }
  await client.query(
    `UPDATE invoice_jobs SET status = 'CANCELLED', error_code = 'PROCESSING_CANCELLED',
       error_message = 'Processing cancelled by user', completed_at = now(), updated_at = now(), version = version + 1
     WHERE tenant_id = $1 AND id = $2`,
    [LOCAL_TENANT_ID, jobId],
  )
  await client.query(
    `UPDATE processing_tasks SET state = 'CANCELLED', leased_by = NULL, lease_expires_at = NULL,
       last_error_code = 'PROCESSING_CANCELLED', last_error_message = 'Processing cancelled by user', updated_at = now()
     WHERE tenant_id = $1 AND job_id = $2 AND state IN ('READY', 'RETRY', 'LEASED')`,
    [LOCAL_TENANT_ID, jobId],
  )
  await audit(client, { tenantId: LOCAL_TENANT_ID, jobId, batchId: current.batchId,
    action: 'PROCESSING_CANCELLED', actor, detail: 'Invoice processing cancelled by user' })
  return current.batchId
}

async function refreshBatchAfterCancellation(client: import('../../db/pool.js').DatabaseClient, batchId: string) {
  const counts = await client.query<{ active: string; cancelled: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('QUEUED', 'PREPROCESSING', 'OCR_RUNNING', 'MAPPING', 'VALIDATING')) AS active,
            count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
            count(*) FILTER (WHERE status IN ('FAILED', 'REJECTED')) AS failed
     FROM invoice_jobs WHERE tenant_id = $1 AND batch_id = $2`,
    [LOCAL_TENANT_ID, batchId],
  )
  const row = counts.rows[0]
  if (Number(row?.active ?? 0) === 0 && Number(row?.cancelled ?? 0) > 0) {
    await client.query(
      `UPDATE invoice_batches SET status = 'COMPLETED_WITH_ERRORS', completed_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status <> 'CANCELLED'`,
      [LOCAL_TENANT_ID, batchId],
    )
  }
}

export async function buildApi(config: Config, database: Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, bodyLimit: config.IES_MAX_BATCH_SIZE * config.IES_MAX_FILE_BYTES })
  const auth = new AuthService(config)
  const metrics = new Registry()
  collectDefaultMetrics({ register: metrics, prefix: 'ies_api_' })
  const requests = new Counter({ name: 'ies_api_http_requests_total', help: 'API requests', labelNames: ['method', 'route', 'status'], registers: [metrics] })

  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || config.allowedOrigins.includes(origin)),
    credentials: true,
  })
  await app.register(multipart, {
    limits: { files: config.IES_MAX_BATCH_SIZE, fileSize: config.IES_MAX_FILE_BYTES, parts: config.IES_MAX_BATCH_SIZE + 1 },
  })

  app.addHook('onRequest', async (request, reply) => {
    const correlationId = request.headers['x-correlation-id']?.toString() || randomUUID()
    reply.header('x-correlation-id', correlationId)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
  })
  app.addHook('onResponse', async (request, reply) => {
    requests.inc({ method: request.method, route: request.routeOptions.url ?? 'unknown', status: String(reply.statusCode) })
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send({ code: error.code, message: error.message })
      return
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({ code: 'INVALID_REQUEST', message: 'Request validation failed' })
      return
    }
    request.log.error({ error }, 'Unhandled API error')
    void reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Request failed' })
  })

  app.get('/health', async () => ({ status: 'UP', service: 'ies-api' }))
  app.get('/actuator/health', async () => ({ status: 'UP' }))
  app.get('/actuator/health/liveness', async () => ({ status: 'UP' }))
  app.get('/actuator/health/readiness', async (_request, reply) => {
    try {
      await database.query('SELECT 1')
      return { status: 'UP' }
    } catch {
      return reply.status(503).send({ status: 'DOWN' })
    }
  })
  app.get('/metrics', async (_request, reply) => {
    reply.type(metrics.contentType)
    return metrics.metrics()
  })

  app.post('/api/v1/invoices', async (request, reply) => {
    const actor = await auth.actor(request.headers.authorization)
    const files: StoredUpload[] = []
    let databaseCommitted = false
    try {
      let invoiceType: 'STANDARD' | 'TES' = 'STANDARD'
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname !== 'invoiceType') throw new ApiError(400, 'Only the files and invoiceType fields are accepted', 'INVALID_MULTIPART_FIELD')
          const requested = String(part.value).toUpperCase()
          if (requested !== 'STANDARD' && requested !== 'TES') throw new ApiError(400, 'Invalid invoice type', 'INVALID_INVOICE_TYPE')
          invoiceType = requested
          continue
        }
        if (part.fieldname !== 'files') throw new ApiError(400, 'Only the files field is accepted', 'INVALID_MULTIPART_FIELD')
        files.push(await storeUpload(part, config))
      }
      if (!files.length) throw new ApiError(400, 'Upload between 1 and 100 files per batch', 'EMPTY_BATCH')
      if (files.length > config.IES_MAX_BATCH_SIZE) throw new ApiError(400, 'Batch exceeds configured file limit', 'BATCH_TOO_LARGE')

      const batchId = id()
      const jobs = await transaction(database, async (client) => {
        await client.query(
          `INSERT INTO invoice_batches(id, tenant_id, submitted_by, document_count, status)
           VALUES ($1, $2, $3, $4, 'PROCESSING')`,
          [batchId, LOCAL_TENANT_ID, actor, files.length],
        )
        const items: Array<{ id: string; filename: string; status: string; duplicate: boolean; message: string }> = []
        let queued = 0
        for (const file of files) {
          const duplicate = await client.query<{ id: string; status: string }>(
            `SELECT id, status FROM invoice_jobs
             WHERE tenant_id = $1 AND sha256 = $2 AND status NOT IN ('FAILED', 'REJECTED')
             ORDER BY created_at DESC LIMIT 1`,
            [LOCAL_TENANT_ID, file.sha256],
          )
          const duplicateOf = duplicate.rows[0]?.id ?? null
          const jobId = id()
          await client.query(
            `INSERT INTO invoice_jobs
               (id, tenant_id, batch_id, original_filename, stored_filename, sha256, content_type, size_bytes, status, invoice_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'QUEUED', $9)`,
            [jobId, LOCAL_TENANT_ID, batchId, file.originalFilename, file.storedFilename, file.sha256, file.contentType, file.sizeBytes, invoiceType],
          )
          await client.query(
            `INSERT INTO processing_tasks(id, tenant_id, job_id) VALUES ($1, $2, $3)`,
            [id(), LOCAL_TENANT_ID, jobId],
          )
          await audit(client, { tenantId: LOCAL_TENANT_ID, jobId, batchId, action: 'UPLOADED', actor,
            detail: duplicateOf ? 'Duplicate detected; retained and queued by user request' : 'File accepted and queued',
            metadata: { sha256: file.sha256, duplicateOf } })
          items.push({ id: jobId, filename: file.originalFilename, status: 'QUEUED', duplicate: Boolean(duplicateOf),
            message: duplicateOf ? 'Queued as a new batch item; identical content was processed previously' : 'Queued' })
          queued += 1
        }
        if (!queued) await client.query("UPDATE invoice_batches SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [batchId])
        const duplicates = items.filter((item) => item.duplicate).length
        await audit(client, { tenantId: LOCAL_TENANT_ID, batchId, action: 'BATCH_SUBMITTED', actor, detail: `${files.length} documents submitted`, metadata: { queued, duplicates } })
        return items
      })
      databaseCommitted = true
      return reply.status(202).send({ batchId, jobs })
    } catch (error) {
      if (!databaseCommitted) await fileCleanup(files)
      throw error
    }
  })

  app.get('/api/v1/invoices', async (request) => {
    await auth.actor(request.headers.authorization)
    const query = request.query as { status?: string; page?: string; size?: string }
    const status = query.status?.toUpperCase()
    if (status && !(JOB_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, 'Invalid invoice status', 'INVALID_STATUS')
    const page = Math.max(0, Number.parseInt(query.page ?? '0', 10) || 0)
    const size = Math.min(100, Math.max(1, Number.parseInt(query.size ?? '25', 10) || 25))
    const parameters: unknown[] = [LOCAL_TENANT_ID]
    let where = 'tenant_id = $1'
    if (status) {
      parameters.push(status)
      where += ` AND status = $${parameters.length}`
    }
    const count = await database.query<{ total: string }>(`SELECT count(*) AS total FROM invoice_jobs WHERE ${where}`, parameters)
    parameters.push(size, page * size)
    const result = await database.query<JobResponse>(
      `SELECT ${JOB_COLUMNS} FROM invoice_jobs WHERE ${where} ORDER BY created_at DESC LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
      parameters,
    )
    const totalElements = Number(count.rows[0]?.total ?? 0)
    return { content: result.rows.map(publicJob), totalElements, totalPages: Math.ceil(totalElements / size), number: page, size }
  })

  app.get('/api/v1/invoices/:id', async (request) => {
    await auth.actor(request.headers.authorization)
    const jobId = uuidSchema.parse((request.params as { id: string }).id)
    const result = await database.query<JobResponse>(`SELECT ${JOB_COLUMNS} FROM invoice_jobs WHERE tenant_id = $1 AND id = $2`, [LOCAL_TENANT_ID, jobId])
    if (!result.rows[0]) throw new ApiError(404, 'Invoice not found', 'NOT_FOUND')
    return publicJob(result.rows[0])
  })

  app.post('/api/v1/invoices/:id/cancel', async (request) => {
    const actor = await auth.actor(request.headers.authorization)
    const jobId = uuidSchema.parse((request.params as { id: string }).id)
    return transaction(database, async (client) => {
      const batchId = await cancelJob(client, jobId, actor)
      const updated = await getJob(client, LOCAL_TENANT_ID, jobId)
      await refreshBatchAfterCancellation(client, batchId)
      return publicJob(updated!)
    })
  })

  app.post('/api/v1/batches/:id/cancel', async (request) => {
    const actor = await auth.actor(request.headers.authorization)
    const batchId = uuidSchema.parse((request.params as { id: string }).id)
    return transaction(database, async (client) => {
      const batch = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM invoice_batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [LOCAL_TENANT_ID, batchId],
      )
      if (!batch.rows[0]) throw new ApiError(404, 'Invoice batch not found', 'NOT_FOUND')
      const jobs = await client.query<{ id: string }>(
        `SELECT id FROM invoice_jobs WHERE tenant_id = $1 AND batch_id = $2
         AND status IN ('QUEUED', 'PREPROCESSING', 'OCR_RUNNING', 'MAPPING', 'VALIDATING') FOR UPDATE`,
        [LOCAL_TENANT_ID, batchId],
      )
      if (!jobs.rows.length) throw new ApiError(409, 'Batch has no invoices that can be cancelled', 'INVALID_STATE')
      for (const job of jobs.rows) await cancelJob(client, job.id, actor)
      await client.query(
        `UPDATE invoice_batches SET status = 'CANCELLED', completed_at = now() WHERE tenant_id = $1 AND id = $2`,
        [LOCAL_TENANT_ID, batchId],
      )
      await audit(client, { tenantId: LOCAL_TENANT_ID, batchId, action: 'BATCH_PROCESSING_CANCELLED', actor,
        detail: `Cancelled ${jobs.rows.length} invoice(s) in batch` })
      return { batchId, cancelledJobs: jobs.rows.length, status: 'CANCELLED' }
    })
  })

  app.get('/api/v1/invoices/:id/source', async (request, reply) => {
    await auth.actor(request.headers.authorization)
    const jobId = uuidSchema.parse((request.params as { id: string }).id)
    const result = await database.query<{ storedFilename: string; filename: string; contentType: string }>(
      `SELECT stored_filename AS "storedFilename", original_filename AS filename, content_type AS "contentType"
       FROM invoice_jobs WHERE tenant_id = $1 AND id = $2`,
      [LOCAL_TENANT_ID, jobId],
    )
    const source = result.rows[0]
    if (!source) throw new ApiError(404, 'Invoice not found', 'NOT_FOUND')

    const path = storagePath(config, source.storedFilename)
    let fileSize: number
    try {
      fileSize = (await stat(path)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ApiError(404, 'Source invoice is unavailable', 'SOURCE_NOT_FOUND')
      }
      throw error
    }

    const encodedFilename = encodedDownloadFilename(source.filename)
    reply.header('content-type', invoiceContentType(source.filename))
    reply.header('content-length', fileSize)
    reply.header('content-disposition', `inline; filename*=UTF-8''${encodedFilename}`)
    reply.header('cache-control', 'private, no-store')
    reply.header('x-frame-options', 'SAMEORIGIN')
    reply.header('content-security-policy', "frame-ancestors 'self'")
    return reply.send(createReadStream(path))
  })

  app.get('/api/v1/invoices/:id/audit', async (request, reply) => {
    const actor = await auth.actor(request.headers.authorization)
    const jobId = uuidSchema.parse((request.params as { id: string }).id)
    const result = await database.query<{ batchId: string; status: string }>(
      'SELECT batch_id AS "batchId", status FROM invoice_jobs WHERE tenant_id = $1 AND id = $2',
      [LOCAL_TENANT_ID, jobId],
    )
    if (!result.rows[0]) throw new ApiError(404, 'Invoice not found', 'NOT_FOUND')
    if (['QUEUED', 'PREPROCESSING', 'OCR_RUNNING', 'MAPPING', 'VALIDATING'].includes(result.rows[0].status)) {
      throw new ApiError(409, 'Invoice audit is available after processing reaches a terminal or review state', 'AUDIT_NOT_READY')
    }
    await transaction(database, (client) => audit(client, {
      tenantId: LOCAL_TENANT_ID,
      jobId,
      batchId: result.rows[0]!.batchId,
      action: 'AUDIT_PACKAGE_REQUESTED',
      actor,
      detail: 'Invoice audit package requested for download',
    }))
    const archive = await createInvoiceAuditArchive(config, database, LOCAL_TENANT_ID, jobId)
    return sendAuditArchive(reply, archive)
  })

  app.get('/api/v1/batches/:id/audit', async (request, reply) => {
    const actor = await auth.actor(request.headers.authorization)
    const batchId = uuidSchema.parse((request.params as { id: string }).id)
    const exists = await database.query<{ exists: number }>('SELECT 1 AS exists FROM invoice_batches WHERE tenant_id = $1 AND id = $2', [LOCAL_TENANT_ID, batchId])
    if (!exists.rows[0]) throw new ApiError(404, 'Invoice batch not found', 'NOT_FOUND')
    const active = await database.query<{ count: string }>(
      `SELECT count(*) AS count FROM invoice_jobs WHERE tenant_id = $1 AND batch_id = $2
         AND status IN ('QUEUED', 'PREPROCESSING', 'OCR_RUNNING', 'MAPPING', 'VALIDATING')`,
      [LOCAL_TENANT_ID, batchId],
    )
    if (Number(active.rows[0]?.count ?? 0) > 0) {
      throw new ApiError(409, 'Batch audit is available after every invoice finishes processing', 'AUDIT_NOT_READY')
    }
    await transaction(database, (client) => audit(client, {
      tenantId: LOCAL_TENANT_ID,
      batchId,
      action: 'BATCH_AUDIT_PACKAGE_REQUESTED',
      actor,
      detail: 'Batch audit package requested for download',
    }))
    const archive = await createBatchAuditArchive(config, database, LOCAL_TENANT_ID, batchId)
    return sendAuditArchive(reply, archive)
  })

  app.get('/api/v1/invoices/:id/events', async (request) => {
    await auth.actor(request.headers.authorization)
    const jobId = uuidSchema.parse((request.params as { id: string }).id)
    const result = await database.query(
      `SELECT id, action, actor, detail, created_at AS "createdAt"
       FROM audit_events WHERE tenant_id = $1 AND job_id = $2 ORDER BY created_at ASC`,
      [LOCAL_TENANT_ID, jobId],
    )
    if (!result.rowCount) {
      const exists = await database.query('SELECT 1 FROM invoice_jobs WHERE tenant_id = $1 AND id = $2', [LOCAL_TENANT_ID, jobId])
      if (!exists.rowCount) throw new ApiError(404, 'Invoice not found', 'NOT_FOUND')
    }
    return result.rows
  })

  app.patch('/api/v1/invoices/:id/review', async (request) => {
    const actor = await auth.actor(request.headers.authorization)
    const jobId = uuidSchema.parse((request.params as { id: string }).id)
    const review = reviewSchema.parse(request.body)
    return transaction(database, async (client) => {
      const job = await getJob(client, LOCAL_TENANT_ID, jobId, true)
      if (!job) throw new ApiError(404, 'Invoice not found', 'NOT_FOUND')
      if (job.status !== 'PENDING_REVIEW') throw new ApiError(409, 'Only pending-review invoices can be reviewed', 'INVALID_STATE')
      const validation = validateInvoice(review.extraction, config.IES_MIN_FIELD_CONFIDENCE)
      const confidence = overallConfidence(review.extraction)
      await persistExtraction(client, { tenantId: LOCAL_TENANT_ID, jobId, invoice: review.extraction, validation, confidence,
        engine: `${job.engine ?? 'unknown'}+human-review`, source: 'HUMAN_REVIEW', actor })
      const status = review.approved ? 'COMPLETED' : 'REJECTED'
      await client.query(
        `UPDATE invoice_jobs SET status = $3, extraction_json = $4::jsonb, validation_json = $5::jsonb,
           overall_confidence = $6, extraction_engine = $7, updated_at = now(), completed_at = now(), version = version + 1
         WHERE tenant_id = $1 AND id = $2`,
        [LOCAL_TENANT_ID, jobId, status, JSON.stringify(review.extraction), JSON.stringify(validation), confidence,
          `${job.engine ?? 'unknown'}+human-review`],
      )
      await audit(client, { tenantId: LOCAL_TENANT_ID, jobId, batchId: job.batchId,
        action: review.approved ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED', actor, detail: review.remarks })
      const updated = await getJob(client, LOCAL_TENANT_ID, jobId)
      return publicJob(updated!)
    })
  })

  app.get('/api/v1/dashboard', async (request) => {
    await auth.actor(request.headers.authorization)
    const counts = await database.query<{ status: string; count: string }>(
      'SELECT status, count(*) AS count FROM invoice_jobs WHERE tenant_id = $1 GROUP BY status',
      [LOCAL_TENANT_ID],
    )
    const values = new Map(counts.rows.map((row) => [row.status, Number(row.count)]))
    const processing = ['PREPROCESSING', 'OCR_RUNNING', 'MAPPING', 'VALIDATING'].reduce((sum, status) => sum + (values.get(status) ?? 0), 0)
    const total = [...values.values()].reduce((sum, value) => sum + value, 0)
    const benchmark = await database.query<{ releaseApproved: boolean }>(
      `SELECT release_approved AS "releaseApproved" FROM release_accuracy_status
       WHERE representative_holdout = true ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
    )
    return {
      total,
      queued: values.get('QUEUED') ?? 0,
      processing,
      pendingReview: values.get('PENDING_REVIEW') ?? 0,
      completed: values.get('COMPLETED') ?? 0,
      failed: values.get('FAILED') ?? 0,
      targets: {
        fieldAccuracy: '>=95%',
        throughput: '>=200 invoices/hour',
        p95Latency: '<15 seconds',
        status: benchmark.rows[0]?.releaseApproved ? 'verified on representative holdout' : 'awaiting representative holdout evidence',
      },
    }
  })

  return app
}
