import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { Database } from './pool.js'

const MIGRATION_LOCK = 7_645_837_211

export async function migrate(database: Database, directory = resolve(process.cwd(), 'db/migrations')): Promise<string[]> {
  const client = await database.connect()
  const applied: string[] = []
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK])
    await client.query(`
      CREATE TABLE IF NOT EXISTS ies_schema_migrations (
        version varchar(200) PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()
    for (const file of files) {
      const sql = await readFile(resolve(directory, file), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM ies_schema_migrations WHERE version = $1',
        [file],
      )
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${file}`)
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO ies_schema_migrations(version, checksum) VALUES ($1, $2)', [file, checksum])
        await client.query('COMMIT')
        applied.push(file)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
    return applied
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined)
    client.release()
  }
}
