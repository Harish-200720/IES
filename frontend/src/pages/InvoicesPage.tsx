import { useMemo } from 'react'
import SearchRounded from '@mui/icons-material/SearchRounded'
import { Alert, Box, Card, CardContent, CircularProgress, InputAdornment, MenuItem, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { getInvoices } from '../api'
import { StatusChip } from '../components/StatusChip'
import type { JobStatus } from '../types'

export function InvoicesPage() {
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') || '') as JobStatus | ''
  const search = params.get('q') || ''
  const query = useQuery({ queryKey: ['invoices', status], queryFn: () => getInvoices(status || undefined), refetchInterval: 5000 })
  const rows = useMemo(() => (query.data?.content || []).filter(row => row.filename.toLowerCase().includes(search.toLowerCase())), [query.data, search])
  return <Stack spacing={3}>
    <Box><Typography variant="h1">All invoices</Typography><Typography color="text.secondary" mt={.7}>Search, filter and open any invoice processing record.</Typography></Box>
    <Card><CardContent sx={{ p: 2.5 }}><Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} mb={2.5}><TextField value={search} onChange={event => { params.set('q', event.target.value); setParams(params) }} placeholder="Search filename" size="small" fullWidth slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchRounded /></InputAdornment> } }} /><TextField select size="small" label="Status" value={status} onChange={event => { const value = event.target.value; value ? params.set('status', value) : params.delete('status'); setParams(params) }} sx={{ minWidth: 190 }}><MenuItem value="">All statuses</MenuItem>{['QUEUED','PREPROCESSING','OCR_RUNNING','MAPPING','VALIDATING','PENDING_REVIEW','COMPLETED','FAILED','REJECTED','CANCELLED'].map(value => <MenuItem key={value} value={value}>{value.replaceAll('_', ' ')}</MenuItem>)}</TextField></Stack>
      {query.isLoading ? <Box py={8} display="grid" sx={{ placeItems: 'center' }}><CircularProgress /></Box> : query.isError ? <Alert severity="error">Unable to load invoices.</Alert> : <Box className="table-scroll"><Table><TableHead><TableRow><TableCell>Invoice file</TableCell><TableCell>Status</TableCell><TableCell>Confidence</TableCell><TableCell>Engine</TableCell><TableCell>Latency</TableCell><TableCell>Received</TableCell></TableRow></TableHead><TableBody>{rows.map(job => <TableRow key={job.id} component={Link} to={`/invoices/${job.id}`} className="clickable-row"><TableCell><Typography variant="body2" fontWeight={750}>{job.filename}</Typography><Typography variant="caption" color="text.secondary">{(job.sizeBytes / 1024).toFixed(0)} KB</Typography></TableCell><TableCell><StatusChip status={job.status}/></TableCell><TableCell>{job.confidence == null ? '—' : `${Math.round(job.confidence * 100)}%`}</TableCell><TableCell>{job.engine || '—'}</TableCell><TableCell>{job.latencyMs == null ? '—' : `${(job.latencyMs / 1000).toFixed(1)}s`}</TableCell><TableCell>{new Date(job.createdAt).toLocaleString()}</TableCell></TableRow>)}{!rows.length && <TableRow><TableCell colSpan={6} align="center" sx={{ py: 7, color: 'text.secondary' }}>No invoices match this view.</TableCell></TableRow>}</TableBody></Table></Box>}
    </CardContent></Card>
  </Stack>
}
