import { hostname } from 'node:os'

import type { Config } from '../../config.js'
import { audit, persistExtraction } from '../../db/repository.js'
import { transaction, type Database } from '../../db/pool.js'
import { validateInvoice } from '../../domain/validation.js'
import { errorMessage } from '../../shared/errors.js'
import { id } from '../../shared/ids.js'
import { storagePath } from '../../storage.js'
import { extractInvoice } from './ai-client.js'

interface ClaimedTask {
  taskId: string
  tenantId: string
  jobId: string
  batchId: string
  storedFilename: string
  originalFilename: string
  contentType: string
  invoiceType: 'STANDARD' | 'TES'
  attempts: number
  maxAttempts: number
}

export class InvoiceProcessor {
  private readonly workerId = `${hostname()}-${process.pid}-${id().slice(0, 8)}`
  private active = 0
  private timer?: NodeJS.Timeout
  private stopping = false
  private filling = false

  constructor(
    private readonly config: Config,
    private readonly database: Database,
    private readonly extractor: typeof extractInvoice = extractInvoice,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.fillCapacity(), this.config.IES_PROCESSOR_POLL_MS)
    this.timer.unref()
    void this.recoverExpiredLeases().then(() => this.fillCapacity())
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    while (this.active > 0 || this.filling) await new Promise((resolve) => setTimeout(resolve, 50))
  }

  status() {
    return { workerId: this.workerId, active: this.active, concurrency: this.config.IES_PROCESSOR_CONCURRENCY }
  }

  private async fillCapacity(): Promise<void> {
    if (this.stopping || this.filling) return
    this.filling = true
    try {
      while (!this.stopping && this.active < this.config.IES_PROCESSOR_CONCURRENCY) {
        const task = await this.claim().catch(() => undefined)
        if (!task) return
        this.active += 1
        void this.process(task).catch(() => {
          // A database outage can prevent failOrRetry from persisting state.
          // Leave the lease recoverable; do not produce an unhandled rejection.
        }).finally(() => {
          this.active -= 1
          void this.fillCapacity()
        })
      }
    } finally {
      this.filling = false
    }
  }

  private async recoverExpiredLeases(): Promise<void> {
    await this.database.query(
      `UPDATE processing_tasks SET state = 'RETRY', leased_by = NULL, lease_expires_at = NULL,
         available_at = now(), updated_at = now(), last_error_code = 'LEASE_EXPIRED'
       WHERE state = 'LEASED' AND lease_expires_at < now()`,
    )
  }

  private claim(): Promise<ClaimedTask | undefined> {
    return transaction(this.database, async (client) => {
      const claimed = await client.query<{ taskId: string; tenantId: string; jobId: string; attempts: number; maxAttempts: number }>(
        `WITH candidate AS (
           SELECT id FROM processing_tasks
           WHERE state IN ('READY', 'RETRY') AND available_at <= now()
           ORDER BY available_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE processing_tasks task
         SET state = 'LEASED', attempts = attempts + 1, leased_by = $1,
             lease_expires_at = now() + ($2 * interval '1 second'), updated_at = now()
         FROM candidate WHERE task.id = candidate.id
         RETURNING task.id AS "taskId", task.tenant_id AS "tenantId", task.job_id AS "jobId",
                   task.attempts, task.max_attempts AS "maxAttempts"`,
        [this.workerId, Math.max(this.config.IES_PROCESSOR_LEASE_SECONDS, Math.ceil(this.config.IES_AI_TIMEOUT_MS / 1000) + 120)],
      )
      const task = claimed.rows[0]
      if (!task) return undefined
      const job = await client.query<{ batchId: string; storedFilename: string; originalFilename: string; contentType: string; invoiceType: 'STANDARD' | 'TES' }>(
        `UPDATE invoice_jobs SET status = 'PREPROCESSING', started_at = COALESCE(started_at, now()),
           updated_at = now(), version = version + 1
         WHERE id = $1 AND tenant_id = $2
         RETURNING batch_id AS "batchId", stored_filename AS "storedFilename",
                   original_filename AS "originalFilename", content_type AS "contentType",
                   invoice_type AS "invoiceType"`,
        [task.jobId, task.tenantId],
      )
      if (!job.rows[0]) throw new Error('JOB_NOT_FOUND')
      await audit(client, { tenantId: task.tenantId, jobId: task.jobId, batchId: job.rows[0].batchId,
        action: 'PROCESSING_STARTED', actor: this.workerId, detail: `Processing attempt ${task.attempts}` })
      return { ...task, ...job.rows[0] }
    })
  }

  private async process(task: ClaimedTask): Promise<void> {
    try {
      await this.database.query(
        "UPDATE invoice_jobs SET status = 'OCR_RUNNING', updated_at = now(), version = version + 1 WHERE id = $1 AND tenant_id = $2",
        [task.jobId, task.tenantId],
      )
      const extraction = await this.extractor(this.config, {
        jobId: task.jobId,
        path: storagePath(this.config, task.storedFilename),
        originalFilename: task.originalFilename,
        contentType: task.contentType,
        invoiceType: task.invoiceType,
      })
      const currentJob = await this.database.query<{ status: string }>(
        'SELECT status FROM invoice_jobs WHERE id = $1 AND tenant_id = $2',
        [task.jobId, task.tenantId],
      )
      if (currentJob.rows[0]?.status === 'CANCELLED') {
        await this.database.query(
          `UPDATE processing_tasks SET state = 'CANCELLED', leased_by = NULL, lease_expires_at = NULL,
             updated_at = now() WHERE id = $1 AND leased_by = $2`,
          [task.taskId, this.workerId],
        )
        return
      }
      await this.database.query(
        "UPDATE invoice_jobs SET status = 'VALIDATING', updated_at = now(), version = version + 1 WHERE id = $1 AND tenant_id = $2",
        [task.jobId, task.tenantId],
      )
      const validation = validateInvoice(extraction.invoice, this.config.IES_MIN_FIELD_CONFIDENCE, extraction.warnings)
      await transaction(this.database, async (client) => {
        await client.query('SELECT id FROM invoice_jobs WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [task.jobId, task.tenantId])
        await persistExtraction(client, {
          tenantId: task.tenantId,
          jobId: task.jobId,
          invoice: extraction.invoice,
          validation,
          confidence: extraction.overall_confidence,
          engine: extraction.engine,
          source: 'AI',
          actor: this.workerId,
        })
        const finalStatus = validation.reviewRequired ? 'PENDING_REVIEW' : 'COMPLETED'
        await client.query(
          `UPDATE invoice_jobs SET status = $3, overall_confidence = $4, extraction_engine = $5,
             extraction_json = $6::jsonb, validation_json = $7::jsonb, error_code = NULL, error_message = NULL,
             ocr_evidence_json = $8::jsonb, updated_at = now(), completed_at = now(),
             extraction_completed_at = now(), version = version + 1
           WHERE id = $1 AND tenant_id = $2`,
          [task.jobId, task.tenantId, finalStatus, extraction.overall_confidence, extraction.engine,
            JSON.stringify(extraction.invoice), JSON.stringify(validation), JSON.stringify(extraction.ocr_evidence)],
        )
        await client.query(
          `UPDATE processing_tasks SET state = 'COMPLETED', leased_by = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND leased_by = $2`,
          [task.taskId, this.workerId],
        )
        await audit(client, { tenantId: task.tenantId, jobId: task.jobId, batchId: task.batchId, action: finalStatus,
          actor: this.workerId, detail: `Extraction completed using ${extraction.engine}`, metadata: {
            confidence: extraction.overall_confidence, confidenceBreakdown: extraction.confidence_breakdown,
            processingMs: extraction.processing_ms, warnings: extraction.warnings,
          } })
        await this.refreshBatch(client, task.batchId)
      })
    } catch (error) {
      await this.failOrRetry(task, error)
    }
  }

  private async failOrRetry(task: ClaimedTask, error: unknown): Promise<void> {
    const currentJob = await this.database.query<{ status: string }>(
      'SELECT status FROM invoice_jobs WHERE id = $1 AND tenant_id = $2',
      [task.jobId, task.tenantId],
    )
    if (currentJob.rows[0]?.status === 'CANCELLED') {
      await this.database.query(
        `UPDATE processing_tasks SET state = 'CANCELLED', leased_by = NULL, lease_expires_at = NULL,
           updated_at = now() WHERE id = $1 AND leased_by = $2`,
        [task.taskId, this.workerId],
      )
      return
    }
    const message = errorMessage(error).slice(0, 1000)
    const errorCode = /^[A-Z0-9_]+$/.test(message) ? message.slice(0, 80) : 'PROCESSING_FAILED'
    await transaction(this.database, async (client) => {
      const busy = errorCode === 'AI_WORKER_BUSY'
      if (busy || task.attempts < task.maxAttempts) {
        const delaySeconds = busy ? 15 : Math.min(60, 2 ** task.attempts)
        await client.query(
          `UPDATE processing_tasks SET state = 'RETRY', leased_by = NULL, lease_expires_at = NULL,
             available_at = now() + ($3 * interval '1 second'), last_error_code = $4, last_error_message = $5,
             attempts = attempts - $6, updated_at = now()
           WHERE id = $1 AND leased_by = $2`,
          [task.taskId, this.workerId, delaySeconds, errorCode, message, busy ? 1 : 0],
        )
        await client.query(
          "UPDATE invoice_jobs SET status = 'QUEUED', error_code = $3, error_message = $4, updated_at = now(), version = version + 1 WHERE id = $1 AND tenant_id = $2",
          [task.jobId, task.tenantId, errorCode, 'Processing will retry automatically'],
        )
        await audit(client, { tenantId: task.tenantId, jobId: task.jobId, batchId: task.batchId,
          action: 'PROCESSING_RETRY', actor: this.workerId, detail: `Retry ${task.attempts} scheduled`, metadata: { errorCode } })
      } else {
        await client.query(
          `UPDATE processing_tasks SET state = 'DEAD_LETTER', leased_by = NULL, lease_expires_at = NULL,
             last_error_code = $3, last_error_message = $4, updated_at = now() WHERE id = $1 AND leased_by = $2`,
          [task.taskId, this.workerId, errorCode, message],
        )
        await client.query(
          `UPDATE invoice_jobs SET status = 'FAILED', error_code = $3, error_message = 'Processing failed after configured retries',
             updated_at = now(), completed_at = now(), version = version + 1 WHERE id = $1 AND tenant_id = $2`,
          [task.jobId, task.tenantId, errorCode],
        )
        await audit(client, { tenantId: task.tenantId, jobId: task.jobId, batchId: task.batchId,
          action: 'PROCESSING_FAILED', actor: this.workerId, detail: 'Processing failed after configured retries', metadata: { errorCode } })
        await this.refreshBatch(client, task.batchId)
      }
    })
  }

  private async refreshBatch(client: import('../../db/pool.js').DatabaseClient, batchId: string): Promise<void> {
    const status = await client.query<{ active: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE status IN ('QUEUED', 'PREPROCESSING', 'OCR_RUNNING', 'MAPPING', 'VALIDATING')) AS active,
              count(*) FILTER (WHERE status IN ('FAILED', 'REJECTED')) AS failed
       FROM invoice_jobs WHERE batch_id = $1`,
      [batchId],
    )
    const counts = status.rows[0]
    if (Number(counts?.active ?? 0) === 0) {
      await client.query(
        `UPDATE invoice_batches SET status = $2, completed_at = now()
         WHERE id = $1`,
        [batchId, Number(counts?.failed ?? 0) ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED'],
      )
    }
  }
}
