import { describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config.js'
import type { Database } from '../src/db/pool.js'
import { InvoiceProcessor } from '../src/services/processor/processor.js'

// Exercise scheduling boundaries without real invoices or an external database.
type Task = { taskId: string; tenantId: string; jobId: string; batchId: string; attempts: number; maxAttempts: number }
type Internals = {
  fillCapacity(): Promise<void>
  claim(): Promise<Task | undefined>
  process(task: Task): Promise<void>
  failOrRetry(task: Task, error: unknown): Promise<void>
}

describe('processor admission and retry boundaries', () => {
  it('serializes overlapping capacity fills while claim awaits the database', async () => {
    const processor = new InvoiceProcessor(loadConfig({ IES_PROCESSOR_CONCURRENCY: '1' }), {} as Database)
    const internal = processor as unknown as Internals
    let finishClaim!: (value: Task | undefined) => void
    const claim = vi.spyOn(internal, 'claim').mockImplementation(() => new Promise((resolve) => { finishClaim = resolve }))
    const first = internal.fillCapacity()
    await internal.fillCapacity()
    expect(claim).toHaveBeenCalledTimes(1)
    finishClaim(undefined)
    await first
    expect(processor.status().active).toBe(0)
    await processor.stop()
  })

  it('busy deferral refunds an attempt even at the retry limit', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'OCR_RUNNING' }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 })
    const database = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Database
    const internal = new InvoiceProcessor(loadConfig({}), database) as unknown as Internals
    await internal.failOrRetry({ taskId: 'task', tenantId: 'tenant', jobId: 'job', batchId: 'batch', attempts: 3, maxAttempts: 3 }, new Error('AI_WORKER_BUSY'))
    const update = query.mock.calls.find(([sql]) => String(sql).includes("state = 'RETRY'"))
    expect(update).toBeDefined()
    expect(update![1][2]).toBe(15)
    expect(update![1][5]).toBe(1)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DEAD_LETTER'))).toBe(false)
  })
})
