import { describe, expect, it } from 'vitest'

import { cleanValue, normalizeInvoice, scoreInvoice, validImo } from '../src/services/processor/canonical.js'
import { buildResponseSchema } from '../src/services/processor/invoice-schema.js'

const T = { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', ARRAY: 'ARRAY' }
type Doc = Record<string, Record<string, { value: unknown; confidence: number }>>

describe('canonical normaliser', () => {
  it('checks the IMO check digit', () => {
    expect(validImo('9074729')).toBe(true)
    expect(validImo('9074720')).toBe(false)
    expect(validImo('123')).toBe(false)
  })

  it('coerces values without inventing anything', () => {
    expect(cleanValue('1,250.50', 'number')).toBe(1250.5)
    expect(cleanValue('3 x 20GP', 'number')).toBeNull()
    expect(cleanValue('N/A', 'string')).toBeNull()
    expect(cleanValue({ value: 'X' }, 'string')).toBe('X')
    expect(cleanValue(5, 'string')).toBe('5')
  })

  it('keeps a missing currency null instead of defaulting to USD', () => {
    const { invoice } = normalizeInvoice({ header: { invoiceNumber: 'A1' } }, 'STANDARD')
    expect((invoice as Doc).header!.currency!.value).toBeNull()
    expect(scoreInvoice(invoice).overall).toBeLessThan(0.7)
  })
})

describe('validation-derived confidence', () => {
  it('rewards reconciled totals and penalises invalid currency codes', () => {
    const { invoice } = normalizeInvoice({
      header: { invoiceNumber: 'A1', invoiceDate: '2026-09-01', currency: 'usd' },
      vendor: { name: 'V' },
      amounts: { taxAmount: 9, total: 109 },
      lineItems: [{ description: 'S', amount: 100 }],
    }, 'STANDARD')
    const score = scoreInvoice(invoice)
    const doc = invoice as Doc
    expect(score.checks.amountsReconcile).toBe('pass')
    expect(doc.amounts!.total!.confidence).toBe(0.98)
    expect(doc.header!.currency!.confidence).toBe(0.3) // 'usd' is not an ISO code as printed
    expect(doc.vessel!.vesselName!.value).toBeNull()
  })

  it('treats terminal lines as gross, forces line discount to 0 and drops empty bbk', () => {
    const { invoice } = normalizeInvoice({
      header: { invoiceNumber: 'T1', invoiceDate: '2026-09-01', currency: 'CNY', vvdCode: 'KGND0536S' },
      vendor: { name: 'Terminal' },
      amounts: { discountAmount: 10, taxAmount: 0, total: 90 },
      lineItems: [
        { description: 'Discharge', amount: 60, discount: 5, size: '40', bbk: { component: null } },
        { description: 'Load', amount: 40 },
      ],
    }, 'TES')
    const score = scoreInvoice(invoice)
    const lines = (invoice as unknown as { lineItems: Array<Record<string, { value: unknown }>> }).lineItems
    expect(score.checks.amountsReconcile).toBe('pass')
    expect(score.checks.vvdCode).toBe('pass')
    expect(lines[0]!.discount!.value).toBe(0)
    expect(lines[0]!.bbk).toBeUndefined()
  })

  it('fails the total and routes the document to review on a mismatch', () => {
    const { invoice } = normalizeInvoice({
      header: { invoiceNumber: 'A1', invoiceDate: '2026-09-01', currency: 'USD' },
      vendor: { name: 'V' },
      amounts: { total: 500 },
      lineItems: [{ description: 'S', amount: 100 }],
    }, 'STANDARD')
    const score = scoreInvoice(invoice)
    expect(score.checks.amountsReconcile).toBe('fail')
    expect((invoice as Doc).amounts!.total!.confidence).toBe(0.3)
    expect(score.overall).toBeLessThan(0.7)
  })
})

describe('response schema', () => {
  it('keeps leaves optional (token-cheap) and adds bbk only for terminal invoices', () => {
    const tes = buildResponseSchema(T, 'TES') as { required: string[]; properties: Record<string, any> }
    expect(tes.required).toEqual(['extractionMetadata', 'header', 'amounts', 'lineItems'])
    expect(tes.properties.lineItems.items.required).toBeUndefined()
    expect(tes.properties.lineItems.items.properties.bbk).toBeDefined()
    expect(tes.properties.header.properties.invoiceNumber.nullable).toBe(true)
    const standard = buildResponseSchema(T, 'STANDARD') as { properties: Record<string, any> }
    expect(standard.properties.lineItems.items.properties.bbk).toBeUndefined()
  })
})
