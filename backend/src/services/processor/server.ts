import Fastify from 'fastify'

import { assertGeminiConfigured, loadConfig } from '../../config.js'
import { migrate } from '../../db/migrate.js'
import { createPool } from '../../db/pool.js'
import { InvoiceProcessor } from './processor.js'

const config = loadConfig()
// Fail at boot, not on the first invoice, when the Gemini key is missing.
if (config.NODE_ENV === 'production') assertGeminiConfigured(config)
const database = createPool(config)
await migrate(database)
const processor = new InvoiceProcessor(config, database)
processor.start()

const app = Fastify({ logger: { level: config.LOG_LEVEL } })
app.get('/health', async () => ({ status: 'UP', service: 'ies-processor', ...processor.status() }))
app.get('/ready', async (_request, reply) => {
  try {
    await database.query('SELECT 1')
    return { status: 'UP' }
  } catch {
    return reply.status(503).send({ status: 'DOWN' })
  }
})

const close = async () => {
  await processor.stop()
  await app.close()
  await database.end()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())

await app.listen({ host: '0.0.0.0', port: config.IES_PROCESSOR_PORT })
