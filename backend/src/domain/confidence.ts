function visit(value: unknown, confidences: number[]): void {
  if (typeof value !== 'object' || value === null) return
  if ('value' in value && 'confidence' in value) {
    const confidence = Number((value as { confidence: unknown }).confidence)
    if (Number.isFinite(confidence)) confidences.push(Math.max(0, Math.min(1, confidence)))
    return
  }
  if (Array.isArray(value)) value.forEach((entry) => visit(entry, confidences))
  else Object.values(value).forEach((entry) => visit(entry, confidences))
}

export function overallConfidence(invoice: Record<string, unknown>): number {
  const confidences: number[] = []
  visit(invoice, confidences)
  return confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0
}
