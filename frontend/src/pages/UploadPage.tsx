import { useRef, useState } from 'react'
import CloudUploadRounded from '@mui/icons-material/CloudUploadRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import LockRounded from '@mui/icons-material/LockRounded'
import { Alert, Box, Button, Card, CardContent, Chip, IconButton, LinearProgress, Stack, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { uploadInvoices } from '../api'

export function UploadPage({ invoiceType = 'STANDARD' }: { invoiceType?: 'STANDARD' | 'TES' }) {
  const input = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const add = (incoming: FileList | null) => setFiles(current => [...current, ...Array.from(incoming || [])].slice(0, 100))

  const submit = async () => {
    setBusy(true); setError('')
    try { 
      await uploadInvoices(files, invoiceType); 
      navigate('/invoices') 
    } catch (failure) { 
      setError(failure instanceof Error ? failure.message : 'Upload failed') 
    } finally { 
      setBusy(false) 
    }
  }

  return <Stack spacing={3}>
    <Box>
      <Typography variant="h1">{invoiceType === 'TES' ? 'Submit terminal invoices' : 'Submit invoice batch'}</Typography>
      <Typography color="text.secondary" mt={.7}>Upload up to 100 invoices. Each document receives its own traceable processing job.</Typography>
    </Box>
    {error && <Alert severity="error">{error}</Alert>}
    <Card><CardContent sx={{ p: { xs: 2, md: 4 } }}>
      <Box className="dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); add(event.dataTransfer.files) }} onClick={() => input.current?.click()}>
        <input ref={input} type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff" onChange={event => add(event.target.files)} />
        <Box className="upload-icon"><CloudUploadRounded /></Box><Typography variant="h2" mt={2}>Drop invoices here</Typography><Typography color="text.secondary" mt={.6}>or click to browse PDF, PNG, JPEG and TIFF · 20 MB per file</Typography><Button variant="outlined" sx={{ mt: 2.5 }}>Choose files</Button>
      </Box>
      {files.length > 0 && <Box mt={3}><Stack direction="row" justifyContent="space-between" mb={1.5}><Typography fontWeight={750}>{files.length} file{files.length > 1 ? 's' : ''} ready</Typography><Button size="small" color="inherit" onClick={() => setFiles([])}>Clear all</Button></Stack><Stack spacing={1}>{files.map((file, index) => <Stack key={`${file.name}-${file.lastModified}-${index}`} className="file-row" direction="row" alignItems="center" spacing={1.5}><Box className="file-type">{file.name.split('.').pop()?.toUpperCase()}</Box><Box flex={1} minWidth={0}><Typography variant="body2" fontWeight={700} noWrap>{file.name}</Typography><Typography variant="caption" color="text.secondary">{(file.size / 1024 / 1024).toFixed(2)} MB</Typography></Box><Chip size="small" label="Ready" color="success" variant="outlined"/><IconButton aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}><DeleteOutlineRounded /></IconButton></Stack>)}</Stack></Box>}
      {busy && <LinearProgress sx={{ mt: 2 }} />}
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} gap={2} mt={3}><Stack direction="row" spacing={1} alignItems="center" color="text.secondary"><LockRounded fontSize="small"/><Typography variant="caption">Documents stay in configured private storage and are excluded from Git.</Typography></Stack><Button size="large" variant="contained" disabled={!files.length || busy} onClick={submit}>Upload and process</Button></Stack>
    </CardContent></Card>
  </Stack>
}