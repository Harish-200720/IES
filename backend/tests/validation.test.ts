import { describe, expect, it } from 'vitest'

import { overallConfidence } from '../src/domain/confidence.js'
import { validateInvoice } from '../src/domain/validation.js'

const field = (value: unknown, confidence = 0.99) => ({ value, confidence, source: 'test' })

function validInvoice() {
  return {
    header: {
      invoiceNumber: field('INV-100'),
      invoiceDate: field(new Date().toISOString().slice(0, 10)),
      currency: field('USD'),
    },
    vendor: { name: field('Synthetic Vendor') },
    amounts: { total: field(109), taxAmount: field(9), shippingAmount: field(0), discountAmount: field(0) },
    lineItems: [{ lineNumber: field('1'), description: field('Service'), amount: field(100) }],
  }
}

const codes = (invoice: Record<string, unknown>, warnings: string[] = []) =>
  validateInvoice(invoice, 0.7, warnings).issues.map((entry) => entry.code)

describe('invoice validation', () => {
  it('accepts a reconciled high-confidence invoice', () => {
    const result = validateInvoice(validInvoice(), 0.7)
    expect(result.reviewRequired).toBe(false)
    expect(result.issues).toEqual([])
  })

  it('routes missing, low-confidence and unreconciled fields to review', () => {
    const invoice = validInvoice()
    invoice.header.invoiceNumber = field(null)
    invoice.amounts.total = field(500, 0.4)
    const result = validateInvoice(invoice, 0.7)
    expect(result.reviewRequired).toBe(true)
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(['MISSING_REQUIRED', 'LOW_CONFIDENCE', 'AMOUNT_MISMATCH']))
  })

  it('reconciles terminal invoices: gross line amounts minus a positive header discount', () => {
    const invoice = validInvoice()
    invoice.amounts = { total: field(90), taxAmount: field(0), shippingAmount: field(0), discountAmount: field(10) }
    invoice.lineItems = [
      { lineNumber: field('1'), description: field('Discharge'), amount: field(60) },
      { lineNumber: field('2'), description: field('Load'), amount: field(40) },
    ]
    expect(codes(invoice)).not.toContain('AMOUNT_MISMATCH')
    // A negative discount (model sign error) must not flip the arithmetic.
    invoice.amounts.discountAmount = field(-10)
    expect(codes(invoice)).not.toContain('AMOUNT_MISMATCH')
  })

  it('includes other charges and still validates pre-canonical reviewed revisions', () => {
    const invoice = validInvoice()
    invoice.amounts = { total: field(112), taxAmount: field(9), shippingAmount: field(0), discountAmount: field(0), otherCharges: field(3) } as never
    expect(codes(invoice)).not.toContain('AMOUNT_MISMATCH')
    const legacy = { ...validInvoice(), amounts: { total: field(109), tax: field(9), shipping: field(0), discount: field(0) } }
    expect(codes(legacy)).not.toContain('AMOUNT_MISMATCH')
  })

  it('computes mean confidence across nested scalar fields', () => {
    expect(overallConfidence({ one: field('a', 1), nested: { two: field('b', 0.5) } })).toBe(0.75)
  })

  it('never silently approves a fallback or missing line items', () => {
    const invoice = validInvoice()
    invoice.lineItems = []
    expect(codes(invoice, ['Schema-constrained decoding was rejected'])).toEqual(expect.arrayContaining(['MISSING_LINE_ITEMS', 'EXTRACTION_WARNING']))
  })

  it('rejects nonnumeric totals and missing line amounts', () => {
    const invoice = validInvoice()
    invoice.amounts.total = field('unknown')
    invoice.lineItems[0]!.amount = field(null)
    expect(codes(invoice)).toEqual(expect.arrayContaining(['INVALID_AMOUNT', 'INVALID_LINE_AMOUNT']))
  })

  it('flags unit prices without quantities and identical supplier/buyer', () => {
    const invoice = {
      ...validInvoice(),
      billTo: { billToEntity: field('Synthetic Vendor') },
      lineItems: [{ description: field('Service'), amount: field(100), unitPrice: field(100) }],
    }
    expect(codes(invoice)).toEqual(expect.arrayContaining(['PRICE_WITHOUT_QUANTITY', 'PARTY_ROLE_AMBIGUOUS']))
  })

  it('does not treat extraction metadata as a low-confidence field', () => {
    const invoice = { ...validInvoice(), extractionMetadata: { extractionStatus: 'Success', pageCount: 1 } }
    expect(codes(invoice)).toEqual([])
  })
})
