import { loadConfig } from '../../config.js'
import { migrate } from '../../db/migrate.js'
import { createPool } from '../../db/pool.js'
import { buildApi } from './app.js'

const config = loadConfig()
const database = createPool(config)
await migrate(database)
const app = await buildApi(config, database)

const close = async () => {
  await app.close()
  await database.end()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())

await app.listen({ host: '0.0.0.0', port: config.IES_API_PORT })
