import { loadConfig } from '../config.js'
import { migrate } from './migrate.js'
import { createPool } from './pool.js'

const database = createPool(loadConfig())
try {
  const applied = await migrate(database)
  process.stdout.write(applied.length ? `Applied migrations: ${applied.join(', ')}\n` : 'Database is up to date\n')
} finally {
  await database.end()
}
