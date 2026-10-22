export const JOB_STATUSES = [
  'QUEUED',
  'PREPROCESSING',
  'OCR_RUNNING',
  'MAPPING',
  'VALIDATING',
  'PENDING_REVIEW',
  'COMPLETED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

export interface ExtractedField {
  value: unknown
  confidence: number
  source?: string
  page?: number | null
}

export interface ValidationIssue {
  field: string
  code: string
  message: string
  severity: 'BLOCK' | 'WARN' | 'INFO'
}

export interface ValidationResult {
  reviewRequired: boolean
  issues: ValidationIssue[]
  ruleVersion: string
}

export interface AiExtractionResponse {
  document_id: string
  invoice: Record<string, unknown>
  overall_confidence: number
  engine: string
  ocr_pages: number
  ocr_evidence: Array<{
    page: number
    text: string
    confidence: number
    quality_score: number
    used_preprocessing: boolean
  }>
  processing_ms: number
  confidence_breakdown: {
    method: string
    mapping_weight: number
    ocr_weight: number
    mapping_confidence: number
    ocr_confidence: number
    populated_fields: number
    required_field_confidence: number
    required_fields_present: number
  }
  warnings: string[]
}
