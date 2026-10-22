import { GoogleGenAI, Type, type GenerateContentConfig, type Schema } from '@google/genai'
import { readFile, stat } from 'node:fs/promises'

import { assertGeminiConfigured, type Config } from '../../config.js'
import type { AiExtractionResponse } from '../../domain/types.js'
import { normalizeInvoice, scoreInvoice, SCORE_METHOD } from './canonical.js'
import { buildResponseSchema, type InvoiceType } from './invoice-schema.js'
import { PROMPT_STANDARD, PROMPT_TES_TERMINAL } from './prompts.js'

export interface ExtractionJobInput {
  jobId: string
  path: string
  originalFilename: string
  contentType: string
  /** Chosen at upload time (Terminal page => TES). Defaults to STANDARD. */
  invoiceType?: InvoiceType
}

/** Gemini rejects inline request bodies above ~20 MB; base64 adds a third, so switch to the Files API early. */
const INLINE_LIMIT_BYTES = 14 * 1024 * 1024
/** Below this remaining budget a schema-less retry cannot realistically finish. */
const MIN_RETRY_BUDGET_MS = 5_000

const UNSUPPORTED_MODEL_TYPES = new Set(['image/tiff'])

type DocumentPart = { inlineData: { mimeType: string; data: string } } | { fileData: { fileUri: string; mimeType: string } }

function classify(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'AI_WORKER_TIMEOUT' || (error instanceof Error && error.name === 'AbortError')) {
    return new Error('AI_WORKER_TIMEOUT')
  }
  if (/\b(?:429|503)\b|RESOURCE_EXHAUSTED|overloaded/i.test(message)) return new Error('AI_WORKER_BUSY')
  return error instanceof Error ? error : new Error(message)
}

function isSchemaRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b400\b|INVALID_ARGUMENT/.test(message) && /schema|constraint|too many states|nesting/i.test(message)
}

function parseModelJson(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(stripped)
  } catch {
    throw new Error('INVALID_MODEL_JSON')
  }
}

async function generate(
  ai: GoogleGenAI,
  config: Config,
  parts: unknown[],
  schema: Schema | undefined,
  budgetMs: number,
): Promise<string> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('AI_WORKER_TIMEOUT'))
    }, budgetMs)
  })
  const generation: Record<string, unknown> = {
    responseMimeType: 'application/json',
    temperature: 0,
    maxOutputTokens: config.IES_AI_MAX_OUTPUT_TOKENS,
    abortSignal: controller.signal,
  }
  if (schema) generation.responseSchema = schema
  if (config.GEMINI_THINKING_BUDGET !== undefined) {
    generation.thinkingConfig = { thinkingBudget: config.GEMINI_THINKING_BUDGET }
  }
  try {
    const call = ai.models.generateContent({
      model: config.GEMINI_MODEL,
      contents: [{ role: 'user', parts }] as never,
      config: generation as GenerateContentConfig,
    })
    call.catch(() => undefined) // the timeout may win the race; never leave an unhandled rejection behind
    const response = await Promise.race([call, timeout])
    const finishReason = response.candidates?.[0]?.finishReason
    if (finishReason !== undefined && String(finishReason) === 'MAX_TOKENS') throw new Error('MODEL_OUTPUT_TRUNCATED')
    const text = response.text
    if (!text) throw new Error('EMPTY_MODEL_RESPONSE')
    return text
  } finally {
    clearTimeout(timer)
  }
}

async function documentPart(
  ai: GoogleGenAI,
  input: ExtractionJobInput,
): Promise<{ part: DocumentPart; cleanup: () => Promise<void> }> {
  const mimeType = input.contentType || 'application/pdf'
  if (UNSUPPORTED_MODEL_TYPES.has(mimeType)) throw new Error('UNSUPPORTED_DOCUMENT_TYPE')
  const size = (await stat(input.path)).size
  if (size <= INLINE_LIMIT_BYTES) {
    const bytes = await readFile(input.path)
    return { part: { inlineData: { mimeType, data: bytes.toString('base64') } }, cleanup: async () => undefined }
  }
  let file = await ai.files.upload({ file: input.path, config: { mimeType } })
  const deadline = Date.now() + 20_000
  while (String(file.state) === 'PROCESSING' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    file = await ai.files.get({ name: file.name ?? '' })
  }
  if (!file.uri || (file.state !== undefined && String(file.state) !== 'ACTIVE')) throw new Error('DOCUMENT_UPLOAD_FAILED')
  const name = file.name
  return {
    part: { fileData: { fileUri: file.uri, mimeType } },
    cleanup: async () => {
      if (name) await ai.files.delete({ name }).catch(() => undefined)
    },
  }
}

export async function extractInvoice(config: Config, input: ExtractionJobInput): Promise<AiExtractionResponse> {
  assertGeminiConfigured(config)
  const startedAt = Date.now()
  const invoiceType: InvoiceType = input.invoiceType ?? 'STANDARD'
  const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY })
  const warnings: string[] = []
  let cleanup: () => Promise<void> = async () => undefined

  try {
    const document = await documentPart(ai, input)
    cleanup = document.cleanup
    const prompt = invoiceType === 'TES' ? PROMPT_TES_TERMINAL : PROMPT_STANDARD
    const parts = [document.part, { text: prompt }]
    const schema = buildResponseSchema(Type, invoiceType) as Schema

    let text: string
    try {
      text = await generate(ai, config, parts, schema, config.IES_AI_TIMEOUT_MS)
    } catch (error) {
      const remaining = config.IES_AI_TIMEOUT_MS - (Date.now() - startedAt)
      if (!isSchemaRejection(error) || remaining < MIN_RETRY_BUDGET_MS) throw error
      // Large schemas (notably TES) can exceed the model's constrained-decoding limits.
      // Fall back to prompt-only JSON, and force review so this is never silently approved.
      warnings.push('Schema-constrained decoding was rejected; prompt-only JSON was used, verify all fields')
      text = await generate(ai, config, parts, undefined, remaining)
    }

    const { invoice, metadata } = normalizeInvoice(parseModelJson(text), invoiceType)
    const score = scoreInvoice(invoice)
    if (metadata.extractionStatus && /^(?:partial|failed)$/i.test(metadata.extractionStatus)) {
      warnings.push(`Model reported extractionStatus=${metadata.extractionStatus}`)
    }

    return {
      document_id: input.jobId,
      invoice,
      overall_confidence: score.overall,
      engine: config.GEMINI_MODEL,
      ocr_pages: metadata.pageCount ?? 0,
      ocr_evidence: [],
      processing_ms: Date.now() - startedAt,
      confidence_breakdown: {
        method: SCORE_METHOD,
        mapping_weight: 1,
        ocr_weight: 0,
        mapping_confidence: score.mapping,
        ocr_confidence: 0,
        populated_fields: score.populated,
        required_field_confidence: score.required,
        required_fields_present: score.requiredPresent,
      },
      warnings,
    }
  } catch (error) {
    throw classify(error)
  } finally {
    await cleanup()
  }
}
