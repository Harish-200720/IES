import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { JOB_COLUMNS } from '../src/db/repository.js'

const database = new PGlite()
const TENANT = '00000000-0000-4000-8000-000000000001'
const BATCH = '31000000-0000-4000-8000-000000000001'

beforeAll(async () => {
  const directory = resolve('db/migrations')
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    await database.exec(await readFile(resolve(directory, file), 'utf8'))
  }
  await database.exec(
    `INSERT INTO invoice_batches(id, tenant_id, submitted_by, document_count) VALUES ('${BATCH}', '${TENANT}', 'test', 2)`,
  )
})

afterAll(async () => database.close())

async function insertJob(id: string, columns: string) {
  await database.exec(`
    INSERT INTO invoice_jobs(id, tenant_id, batch_id, original_filename, stored_filename, sha256, content_type, size_bytes, status${columns.split('|')[0]})
    VALUES ('${id}', '${TENANT}', '${BATCH}', '${id}.pdf', '${id}.pdf', repeat('a', 64), 'application/pdf', 1, 'COMPLETED'${columns.split('|')[1]})
  `)
}

async function latency(id: string): Promise<number | null> {
  const result = await database.query<{ latencyMs: string | number | null }>(`SELECT ${JOB_COLUMNS} FROM invoice_jobs WHERE id = '${id}'`)
  const value = result.rows[0]?.latencyMs
  return value === null || value === undefined ? null : Number(value)
}

describe('end-to-end latency', () => {
  it('includes queue wait and excludes the later human review time', async () => {
    const id = '41000000-0000-4000-8000-000000000001'
    await insertJob(id, ", created_at, started_at, extraction_completed_at, completed_at|, '2026-10-01T10:00:00Z', '2026-10-01T10:00:05Z', '2026-10-01T10:00:09Z', '2026-10-01T10:30:00Z'")
    // 5 s queued + 4 s extracting = 9 s; the 30-minute review gap must not count.
    expect(await latency(id)).toBe(9000)
  })

  it('is null until extraction has finished', async () => {
    const id = '41000000-0000-4000-8000-000000000002'
    await insertJob(id, ', created_at|, \'2026-10-01T10:00:00Z\'')
    expect(await latency(id)).toBeNull()
  })

  it('defaults new jobs to the STANDARD invoice type', async () => {
    const result = await database.query<{ invoice_type: string }>(
      "SELECT invoice_type FROM invoice_jobs WHERE id = '41000000-0000-4000-8000-000000000002'",
    )
    expect(result.rows[0]?.invoice_type).toBe('STANDARD')
  })
})
