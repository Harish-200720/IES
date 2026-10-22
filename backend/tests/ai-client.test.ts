import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { extractInvoice } from '../src/services/processor/ai-client.js'

const mockGenerateContent = vi.fn()

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: (...args: unknown[]) => mockGenerateContent(...args) }
    files = { upload: vi.fn(), get: vi.fn(), delete: vi.fn() }
  },
  Type: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', ARRAY: 'ARRAY' },
}))

const config = (overrides: Record<string, string> = {}) => loadConfig({ GEMINI_API_KEY: 'test-key', ...overrides })

afterEach(() => {
  vi.clearAllMocks()
  mockGenerateContent.mockReset()
})

async function withInput(
  run: (input: { jobId: string; path: string; originalFilename: string; contentType: string }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'ies-ai-client-test-'))
  try {
    const path = join(directory, 'synthetic.pdf')
    await writeFile(path, '%PDF-synthetic-test')
    await run({ jobId: 'synthetic-job', path, originalFilename: 'synthetic.pdf', contentType: 'application/pdf' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('AI client failure classification', () => {
  it('distinguishes worker backpressure from extraction failures', async () => {
    mockGenerateContent.mockRejectedValue(new Error('503 Service Unavailable'))
    await withInput(async (input) => {
      await expect(extractInvoice(config(), input)).rejects.toThrow('AI_WORKER_BUSY')
    })
  })

  it('reports pipeline timeouts explicitly', async () => {
    mockGenerateContent.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 1500)))
    await withInput(async (input) => {
      await expect(extractInvoice(config({ IES_AI_TIMEOUT_MS: '1000' }), input)).rejects.toThrow('AI_WORKER_TIMEOUT')
    })
  })

  it('refuses to call Gemini without a real API key', async () => {
    await withInput(async (input) => {
      await expect(extractInvoice(loadConfig({}), input)).rejects.toThrow('GEMINI_API_KEY_MISSING')
      await expect(extractInvoice(loadConfig({ GEMINI_API_KEY: 'mock-key' }), input)).rejects.toThrow('GEMINI_API_KEY_MISSING')
    })
    expect(mockGenerateContent).not.toHaveBeenCalled()
  })

  it('flags truncated model output instead of parsing a partial document', async () => {
    mockGenerateContent.mockResolvedValue({ text: '{"header":', candidates: [{ finishReason: 'MAX_TOKENS' }] })
    await withInput(async (input) => {
      await expect(extractInvoice(config(), input)).rejects.toThrow('MODEL_OUTPUT_TRUNCATED')
    })
  })
})

describe('AI client extraction', () => {
  it('wraps plain model values into canonical leaves and never invents defaults', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        extractionMetadata: { documentTypeDetected: 'Invoice', pageCount: 1, extractionStatus: 'Success' },
        header: { invoiceNumber: 'INV-123', invoiceDate: '2026-09-01' },
        vendor: { name: 'Vendor Inc' },
        amounts: { taxAmount: 9, total: 109 },
        lineItems: [{ description: 'Service', amount: 100 }],
      }),
    })
    await withInput(async (input) => {
      const result = await extractInvoice(config(), input)
      const invoice = result.invoice as Record<string, Record<string, { value: unknown; confidence: number; source: string }>>
      expect(result.document_id).toBe('synthetic-job')
      expect(invoice.header!.invoiceNumber).toMatchObject({ value: 'INV-123', source: 'gemini' })
      // Currency was not on the document: it must stay null (previously defaulted to USD).
      expect(invoice.header!.currency!.value).toBeNull()
      expect(invoice.amounts!.total!.confidence).toBe(0.98) // reconciled against line + tax
      expect(result.confidence_breakdown.method).toBe('validation-derived-v1')
    })
  })

  it('uses the terminal prompt and schema when the job was uploaded as TES', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ header: { invoiceNumber: 'T1' }, lineItems: [{ description: 'Discharge', amount: 10, discount: 4 }] }),
    })
    await withInput(async (input) => {
      const result = await extractInvoice(config(), { ...input, invoiceType: 'TES' })
      const call = mockGenerateContent.mock.calls[0]![0]
      expect(JSON.stringify(call.contents)).toContain('TES Invoice Extraction Engine')
      expect(call.config.responseSchema.properties.lineItems.items.properties.bbk).toBeDefined()
      expect(call.config.temperature).toBe(0)
      const lines = (result.invoice as { lineItems: Array<{ discount: { value: number } }> }).lineItems
      expect(lines[0]!.discount.value).toBe(0)
    })
  })

  it('retries without a response schema when decoding is rejected, and forces review', async () => {
    mockGenerateContent
      .mockRejectedValueOnce(new Error('400 INVALID_ARGUMENT: response schema has too many states for serving'))
      .mockResolvedValueOnce({ text: JSON.stringify({ header: { invoiceNumber: 'X1' }, lineItems: [] }) })
    await withInput(async (input) => {
      const result = await extractInvoice(config(), input)
      expect(mockGenerateContent).toHaveBeenCalledTimes(2)
      expect(mockGenerateContent.mock.calls[1]![0].config.responseSchema).toBeUndefined()
      expect(result.warnings.join(' ')).toContain('prompt-only JSON')
    })
  })
})
