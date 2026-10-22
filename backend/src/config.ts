import { z } from 'zod'

const booleanValue = z.string().default('false').transform((value) => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()))

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DATABASE_NAME: z.string().min(1).default('ies'),
  DATABASE_USERNAME: z.string().min(1).default('ies_app'),
  DATABASE_PASSWORD: z.string().default(''),
  IES_STORAGE_ROOT: z.string().min(1).default('./data/invoices'),
  // No default: a missing key must fail fast instead of silently calling Gemini with a mock key.
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash'),
  // Unset => model default. 0 disables thinking (lowest latency); -1 lets the model decide.
  GEMINI_THINKING_BUDGET: z.coerce.number().int().min(-1).optional(),
  IES_AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(512).default(16_384),
  IES_ALLOWED_ORIGINS: z.string().default('http://127.0.0.1:5173,http://localhost:5173'),
  IES_AUTH_ENABLED: booleanValue,
  JWT_ISSUER_URI: z.string().default(''),
  JWT_AUDIENCE: z.string().default('ies-api'),
  IES_MAX_FILE_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  IES_MAX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  IES_MIN_FIELD_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  // Per-attempt budget. The latency KPI is p95 < 15 s, so a request that has not
  // finished in 60 s is stuck and is retried by the durable queue.
  IES_AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  IES_PROCESSOR_POLL_MS: z.coerce.number().int().min(100).default(500),
  IES_PROCESSOR_LEASE_SECONDS: z.coerce.number().int().min(15).default(180),
  IES_PROCESSOR_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(6),
  IES_API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  IES_PROCESSOR_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export type Config = ReturnType<typeof loadConfig>

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment)
  return {
    ...parsed,
    allowedOrigins: parsed.IES_ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
  }
}

/** Called before every Gemini request; tests inject a fake extractor and never reach this. */
export function assertGeminiConfigured(config: Pick<Config, 'GEMINI_API_KEY'>): void {
  if (!config.GEMINI_API_KEY.trim() || config.GEMINI_API_KEY === 'mock-key') {
    throw new Error('GEMINI_API_KEY_MISSING')
  }
}

export const LOCAL_TENANT_ID = '00000000-0000-4000-8000-000000000001'
