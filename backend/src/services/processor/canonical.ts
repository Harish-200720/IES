import {
  BBK,
  CORE_LINE_KEYS,
  EXTRACTION_METADATA,
  SECTIONS,
  lineSpec,
  type FieldKind,
  type FieldSpec,
  type InvoiceType,
} from './invoice-schema.js'

export interface Leaf {
  value: string | number | null
  confidence: number
  source: string
  page: number | null
}

export type CanonicalInvoice = Record<string, unknown>

export const LEAF_SOURCE = 'gemini'
export const SCORE_METHOD = 'validation-derived-v1'
/** Field confidences are routing signals derived from cross-checks, not calibrated probabilities. */
export const CONFIDENCE = { verified: 0.98, unverified: 0.85, failed: 0.3, empty: 0 } as const

const NULL_TEXT = /^(?:null|none|n\/a|na|undefined|-|--)$/i
const LABEL_ECHO = /^(?:due_date|invoice_date|bill_to|invoice_no)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce one model value to the schema kind without inventing anything. */
export function cleanValue(raw: unknown, kind: FieldKind): string | number | null {
  if (raw === null || raw === undefined) return null
  // Tolerate a model that still wraps a value as {value: ...} (prompt-only fallback path).
  if (isRecord(raw)) return 'value' in raw ? cleanValue(raw.value, kind) : null
  if (Array.isArray(raw)) return null
  if (kind === 'number') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    if (typeof raw !== 'string') return null
    const text = raw.replace(/[,\s$€£¥]/g, '')
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null
    return Number(text)
  }
  const text = (typeof raw === 'string' ? raw : String(raw)).trim()
  if (!text || NULL_TEXT.test(text) || LABEL_ECHO.test(text)) return null
  return text
}

function leaf(value: string | number | null): Leaf {
  return { value, confidence: 0, source: LEAF_SOURCE, page: null }
}

function buildLeaves(raw: unknown, spec: FieldSpec, always: readonly string[] = Object.keys(spec)): Record<string, Leaf> {
  const source = isRecord(raw) ? raw : {}
  const output: Record<string, Leaf> = {}
  for (const [key, kind] of Object.entries(spec)) {
    const value = cleanValue(source[key], kind)
    if (value !== null || always.includes(key)) output[key] = leaf(value)
  }
  return output
}

export interface NormalizedInvoice {
  invoice: CanonicalInvoice
  metadata: { documentTypeDetected: string | null; pageCount: number | null; extractionStatus: string | null }
}

/** Wrap plain-value model output into canonical {value, confidence, source, page} leaves. */
export function normalizeInvoice(raw: unknown, type: InvoiceType): NormalizedInvoice {
  const root = isRecord(raw) ? raw : {}
  const metaSource = isRecord(root.extractionMetadata) ? root.extractionMetadata : {}
  const metadata = {
    documentTypeDetected: cleanValue(metaSource.documentTypeDetected, EXTRACTION_METADATA.documentTypeDetected ?? 'string') as string | null,
    pageCount: cleanValue(metaSource.pageCount, 'number') as number | null,
    extractionStatus: cleanValue(metaSource.extractionStatus, 'string') as string | null,
  }
  const invoice: CanonicalInvoice = { extractionMetadata: metadata }
  for (const [name, spec] of SECTIONS) invoice[name] = buildLeaves(root[name], spec)

  const spec = lineSpec(type)
  const core = CORE_LINE_KEYS[type]
  const rawLines = Array.isArray(root.lineItems) ? root.lineItems : []
  invoice.lineItems = rawLines.filter(isRecord).map((item) => {
    const line: Record<string, unknown> = buildLeaves(item, spec, core)
    if (type === 'TES') {
      // Terminal rule: line-level discount is always 0; the header carries the discount.
      line.discount = leaf(0)
      const bbk = buildLeaves(item.bbk, BBK, [])
      if (Object.keys(bbk).length) line.bbk = bbk
    }
    return line
  })
  return { invoice, metadata }
}

// ---------------------------------------------------------------------------
// Validation-derived confidence
// ---------------------------------------------------------------------------

function isLeaf(value: unknown): value is Leaf {
  return isRecord(value) && 'value' in value && 'confidence' in value
}

function* leaves(value: unknown): Generator<Leaf> {
  if (isLeaf(value)) {
    yield value
  } else if (Array.isArray(value)) {
    for (const entry of value) yield* leaves(entry)
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) if (key !== 'extractionMetadata') yield* leaves(entry)
  }
}

function leafAt(invoice: CanonicalInvoice, path: string): Leaf | undefined {
  let current: unknown = invoice
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return isLeaf(current) ? current : undefined
}

function numberAt(invoice: CanonicalInvoice, path: string): number | null {
  const value = leafAt(invoice, path)?.value
  return typeof value === 'number' ? value : null
}

/** IMO numbers carry a check digit: weights 7..2 over the first six digits, sum mod 10. */
export function validImo(value: string): boolean {
  if (!/^\d{7}$/.test(value)) return false
  const digits = [...value].map(Number)
  const sum = digits.slice(0, 6).reduce((total, digit, index) => total + digit * (7 - index), 0)
  return sum % 10 === digits[6]
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export interface ScoreResult {
  overall: number
  mapping: number
  populated: number
  required: number
  requiredPresent: number
  checks: Record<string, 'pass' | 'fail' | 'skip'>
}

const REQUIRED_PATHS = ['header.invoiceNumber', 'header.invoiceDate', 'header.currency', 'vendor.name', 'amounts.total']
const ADJUSTMENTS = ['amounts.taxAmount', 'amounts.discountAmount', 'amounts.shippingAmount', 'amounts.otherCharges']
const TOLERANCE = 0.02
const FAILED_CHECK_CAP = 0.6

const round4 = (value: number) => Math.round(value * 10_000) / 10_000
const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)

/**
 * Assigns every populated leaf a confidence from independent cross-checks and returns the document score.
 * Mutates the leaves in `invoice`.
 */
export function scoreInvoice(invoice: CanonicalInvoice): ScoreResult {
  const checks: ScoreResult['checks'] = {}
  const all = [...leaves(invoice)]
  for (const item of all) item.confidence = item.value === null || item.value === '' ? CONFIDENCE.empty : CONFIDENCE.unverified
  const failed = new Set<Leaf>()
  const verify = (item: Leaf | undefined) => {
    if (item && item.value !== null && item.value !== '' && !failed.has(item)) item.confidence = CONFIDENCE.verified
  }
  const fail = (item: Leaf | undefined) => {
    if (item && item.value !== null && item.value !== '') {
      item.confidence = CONFIDENCE.failed
      failed.add(item)
    }
  }
  const judge = (name: string, item: Leaf | undefined, ok: (value: string) => boolean) => {
    if (!item || item.value === null || item.value === '') {
      checks[name] = 'skip'
      return
    }
    const passed = ok(String(item.value))
    checks[name] = passed ? 'pass' : 'fail'
    if (passed) verify(item)
    else fail(item)
  }

  judge('currency', leafAt(invoice, 'header.currency'), (v) => /^[A-Z]{3}$/.test(v))
  judge('invoiceDate', leafAt(invoice, 'header.invoiceDate'), validIsoDate)
  judge('dueDate', leafAt(invoice, 'header.dueDate'), validIsoDate)
  judge('vesselIMO', leafAt(invoice, 'vessel.vesselIMO'), validImo)
  judge('vvdCode', leafAt(invoice, 'header.vvdCode'), (v) => /^[A-Z]{4}\d{4}[NSEW]$/.test(v))

  const lines = Array.isArray(invoice.lineItems) ? invoice.lineItems.filter(isRecord) : []
  const lineAmounts = lines.map((line) => (isLeaf(line.amount) && typeof line.amount.value === 'number' ? line.amount.value : null))
  const total = numberAt(invoice, 'amounts.total')
  if (lines.length && total !== null && lineAmounts.every((amount) => amount !== null)) {
    const sum = lineAmounts.reduce<number>((acc, amount) => acc + (amount ?? 0), 0)
    const expected =
      sum - (numberAt(invoice, 'amounts.discountAmount') ?? 0) + (numberAt(invoice, 'amounts.taxAmount') ?? 0) +
      (numberAt(invoice, 'amounts.shippingAmount') ?? 0) + (numberAt(invoice, 'amounts.otherCharges') ?? 0)
    if (Math.abs(expected - total) <= TOLERANCE) {
      checks.amountsReconcile = 'pass'
      verify(leafAt(invoice, 'amounts.total'))
      for (const path of ADJUSTMENTS) verify(leafAt(invoice, path))
      for (const line of lines) verify(line.amount as Leaf)
      const subtotal = leafAt(invoice, 'amounts.subtotal')
      if (typeof subtotal?.value === 'number' && Math.abs(subtotal.value - sum) <= TOLERANCE) verify(subtotal)
    } else {
      checks.amountsReconcile = 'fail'
      fail(leafAt(invoice, 'amounts.total'))
      for (const path of ADJUSTMENTS) fail(leafAt(invoice, path))
    }
  } else {
    checks.amountsReconcile = 'skip'
  }

  for (const line of lines) {
    const quantity = isLeaf(line.quantity) ? line.quantity : undefined
    const price = isLeaf(line.unitPrice) ? line.unitPrice : undefined
    const amount = isLeaf(line.amount) ? line.amount : undefined
    if (typeof quantity?.value === 'number' && typeof price?.value === 'number' && typeof amount?.value === 'number') {
      const product = quantity.value * price.value
      // A mismatch is neutral (per-100 price bases, multiplied container counts); only agreement adds trust.
      if (Math.abs(product - amount.value) <= Math.max(TOLERANCE, Math.abs(amount.value) * 0.005)) {
        verify(quantity)
        verify(price)
        verify(amount)
      }
    }
  }

  const populated = all.filter((item) => item.confidence > 0)
  const requiredScores = REQUIRED_PATHS.map((path) => leafAt(invoice, path)?.confidence ?? 0)
  const requiredPresent = REQUIRED_PATHS.filter((path) => {
    const value = leafAt(invoice, path)?.value
    return value !== null && value !== undefined && value !== ''
  }).length
  const mapping = mean(populated.map((item) => item.confidence))
  const required = mean(requiredScores)
  // Any failed cross-check caps the document score below the review threshold.
  const anyCheckFailed = Object.values(checks).includes('fail')
  const overall = Math.min(mapping, required, anyCheckFailed ? FAILED_CHECK_CAP : 1)
  return {
    overall: round4(overall),
    mapping: round4(mapping),
    populated: populated.length,
    required: round4(required),
    requiredPresent,
    checks,
  }
}
