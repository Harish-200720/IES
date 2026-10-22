import pg from 'pg'

import type { Config } from '../config.js'

const { Pool } = pg

export type Database = pg.Pool
export type DatabaseClient = pg.PoolClient

export function createPool(config: Config): Database {
  return new Pool({
    ...(config.DATABASE_URL ? { connectionString: config.DATABASE_URL } : {
      host: config.DATABASE_HOST,
      port: config.DATABASE_PORT,
      database: config.DATABASE_NAME,
      user: config.DATABASE_USERNAME,
      password: config.DATABASE_PASSWORD,
    }),
    max: config.NODE_ENV === 'test' ? 2 : 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'ies-node',
  })
}

export async function transaction<T>(database: Database, operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
