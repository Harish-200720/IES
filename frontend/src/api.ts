import axios from 'axios'
import type { AuditEvent, DashboardData, InvoiceJob, JobStatus, PageResponse } from './types'

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api/v1', timeout: 30_000 })

export const getDashboard = async () => (await api.get<DashboardData>('/dashboard')).data

function normalizeInvoice(row: Record<string, unknown>): InvoiceJob {
  return {
    id: String(row.id),
    batchId: String(row.batchId ?? row.batch_id ?? ''),
    batchStatus: String(row.batchStatus ?? row.batch_status ?? 'QUEUED') as InvoiceJob['batchStatus'],
    filename: String(row.filename ?? row.original_filename ?? 'Untitled invoice'),
    status: String(row.status ?? 'QUEUED') as JobStatus,
    sizeBytes: Number(row.sizeBytes ?? row.size_bytes ?? 0),
    confidence: row.confidence == null ? null : Number(row.confidence),
    engine: row.engine == null ? null : String(row.engine),
    extraction: (row.extraction ?? row.invoice ?? null) as InvoiceJob['extraction'],
    validation: (row.validation ?? null) as InvoiceJob['validation'],
    error: row.error == null ? (row.error_message == null ? null : String(row.error_message)) : String(row.error),
    createdAt: String(row.createdAt ?? row.created_at ?? new Date(0).toISOString()),
    updatedAt: String(row.updatedAt ?? row.updated_at ?? new Date(0).toISOString()),
    latencyMs: row.latencyMs == null && row.latency_ms == null ? null : Number(row.latencyMs ?? row.latency_ms),
  }
}

export async function getInvoices(status?: JobStatus): Promise<PageResponse<InvoiceJob>> {
  const response = await api.get<PageResponse<InvoiceJob> | Array<Record<string, unknown>>>('/invoices', { params: { status, size: 100 } })
  if (!Array.isArray(response.data)) return response.data
  const content = response.data.map(normalizeInvoice).filter((invoice) => !status || invoice.status === status)
  return { content, totalElements: content.length, totalPages: 1, number: 0, size: 100 }
}

export async function getInvoice(id: string): Promise<InvoiceJob> {
  const response = await api.get<InvoiceJob | Record<string, unknown>>(`/invoices/${id}`)
  return normalizeInvoice(response.data as Record<string, unknown>)
}

export const getEvents = async (id: string) => (await api.get<AuditEvent[]>(`/invoices/${id}/events`)).data
export const getInvoiceSourceUrl = (id: string) => `${api.defaults.baseURL}/invoices/${encodeURIComponent(id)}/source`
export const getInvoiceAuditUrl = (id: string) => `${api.defaults.baseURL}/invoices/${encodeURIComponent(id)}/audit`
export const getBatchAuditUrl = (id: string) => `${api.defaults.baseURL}/batches/${encodeURIComponent(id)}/audit`

export async function uploadInvoices(files: File[], invoiceType: 'STANDARD' | 'TES' = 'STANDARD') {
  const form = new FormData()
  files.forEach(file => form.append('files', file))
  form.append('invoiceType', invoiceType)
  
  return (await api.post('/invoices', form)).data as { batchId: string; jobs: Array<{ id: string; filename: string; status: JobStatus; duplicate: boolean; message: string }> }
}

export async function reviewInvoice(id: string, extraction: Record<string, unknown>, approved: boolean, remarks: string) {
  return (await api.patch<InvoiceJob>(`/invoices/${id}/review`, { extraction, approved, remarks })).data
}

export async function cancelInvoice(id: string) {
  return (await api.post<InvoiceJob>(`/invoices/${id}/cancel`)).data
}

export async function cancelBatch(id: string) {
  return (await api.post<{ batchId: string; cancelledJobs: number; status: string }>(`/batches/${id}/cancel`)).data
}