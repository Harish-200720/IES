// Canonical invoice schema (SOP ParseJSON field names).
//
// This is the single source of truth for: the Gemini response schema, the
// normaliser that wraps model output into {value, confidence, source, page}
// leaves, and the field names read by validation, persistence and evaluation.
// Keep it dependency-free so it can be unit-tested without the Gemini SDK.

export type InvoiceType = 'STANDARD' | 'TES'
export type FieldKind = 'string' | 'number'
export type FieldSpec = Record<string, FieldKind>

const S: FieldKind = 'string'
const N: FieldKind = 'number'

export const EXTRACTION_METADATA: FieldSpec = { documentTypeDetected: S, pageCount: N, extractionStatus: S }

export const HEADER: FieldSpec = {
  invoiceNumber: S, currency: S, invoiceDate: S, dueDate: S, documentId: S, poNumber: S, poType: S, poTerm: S,
  poDays: N, invoiceCategory: S, invoiceType: S, doAwbNumber: S, chargeFamily: S, vvdCode: S, service: S,
  terminal: S, agent: S, periodFrom: S, periodTo: S, referenceKey: S, settlementEvidence: S, sourceSystem: S,
}
export const VENDOR: FieldSpec = {
  name: S, beneficiaryName: S, vendorCode: S, vendorAddress: S, vendorTaxId: S, vendorEmail: S, vendorPhone: S,
}
export const BILL_TO: FieldSpec = { billToEntity: S, billToAddress: S, billToTaxId: S }
export const VESSEL: FieldSpec = {
  vesselName: S, vesselIMO: S, vesselFlag: S, voyageNumber: S, portOfDelivery: S, nrt: N, grt: N, loa: N,
  pobAt: S, atbAt: S, ataAt: S, atdAt: S, tonnageTaxTier: S,
}
export const AMOUNTS: FieldSpec = {
  subtotal: N, taxAmount: N, taxRate: N, discountAmount: N, discountRate: N, shippingAmount: N, otherCharges: N,
  fxRate: N, amountInWords: S, total: N,
}
export const BANK_DETAILS: FieldSpec = { bankName: S, bankAccount: S, bankIBAN: S, bankSWIFT: S, bankBranch: S }

export const LINE_STANDARD: FieldSpec = {
  lineNumber: S, lineId: S, chargeCode: S, costCode: S, description: S, partNumber: S, quantity: N,
  unitOfMeasure: S, unitPrice: N, amount: N, discount: N, taxCode: S, accountCode: S, poLineReference: S,
}
export const LINE_TES: FieldSpec = {
  ...LINE_STANDARD,
  descriptionChinese: S, descriptionEnglish: S, unitRateBilled: N, amountBilled: N, costType: S, chargeFamily: S,
  lineType: S, lineStatus: S, size: S, containerType: S, isoSizeType: S, cargoClass: S, transshipment: S,
  ladenEmpty: S, route: S, importExport: S, slotOp: S, freightRoute: S, freightDirection: S,
  agreementRateDg: N, agreementRateNonDg: N, agreementRateTotal: N, supportingDocRef: S,
}
export const BBK: FieldSpec = {
  component: S, volume: N, weight: N, length: N, night: S, holiday: S, floatingCrane: S,
  frPieces20: N, frPieces40: N, greaterOf: S,
}

/** Line-item columns that are always materialised (even when null) so review UIs and validation see them. */
export const CORE_LINE_KEYS: Record<InvoiceType, readonly string[]> = {
  STANDARD: ['lineNumber', 'description', 'quantity', 'unitPrice', 'amount', 'chargeCode'],
  TES: ['lineNumber', 'description', 'chargeCode', 'costType', 'chargeFamily', 'size', 'containerType',
    'ladenEmpty', 'quantity', 'unitPrice', 'amount', 'discount'],
}

export const SECTIONS: ReadonlyArray<readonly [string, FieldSpec]> = [
  ['header', HEADER],
  ['vendor', VENDOR],
  ['billTo', BILL_TO],
  ['vessel', VESSEL],
  ['amounts', AMOUNTS],
  ['bankDetails', BANK_DETAILS],
]

export function lineSpec(type: InvoiceType): FieldSpec {
  return type === 'TES' ? LINE_TES : LINE_STANDARD
}

/** The subset of the Gemini `Type` enum this module needs (injected so the SDK stays out of this file). */
export interface SchemaTypes {
  OBJECT: unknown
  STRING: unknown
  NUMBER: unknown
  ARRAY: unknown
}

export interface SchemaNode {
  type: unknown
  nullable?: boolean
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  required?: string[]
}

function leafNode(T: SchemaTypes, kind: FieldKind): SchemaNode {
  return { type: kind === 'number' ? T.NUMBER : T.STRING, nullable: true }
}

function objectNode(T: SchemaTypes, spec: FieldSpec, extra: Record<string, SchemaNode> = {}): SchemaNode {
  const properties: Record<string, SchemaNode> = { ...extra }
  for (const [key, kind] of Object.entries(spec)) properties[key] = leafNode(T, kind)
  return { type: T.OBJECT, properties }
}

/**
 * Response schema with plain-value leaves. Leaf keys are deliberately NOT `required`:
 * forcing the model to emit `null` for every absent key costs hundreds of output tokens per line item.
 * Absent keys are filled with null leaves by the normaliser instead.
 */
export function buildResponseSchema(T: SchemaTypes, type: InvoiceType): SchemaNode {
  const lineItem =
    type === 'TES'
      ? objectNode(T, LINE_TES, { bbk: { ...objectNode(T, BBK), nullable: true } })
      : objectNode(T, LINE_STANDARD)
  const properties: Record<string, SchemaNode> = {
    extractionMetadata: objectNode(T, EXTRACTION_METADATA),
  }
  for (const [name, spec] of SECTIONS) properties[name] = objectNode(T, spec)
  properties.lineItems = { type: T.ARRAY, items: lineItem }
  return { type: T.OBJECT, properties, required: ['extractionMetadata', 'header', 'amounts', 'lineItems'] }
}
