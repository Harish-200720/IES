import { Chip } from '@mui/material'

export function StatusChip({ status }: { status: string }) {
  let label = status
  let color: 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning' = 'default'

  switch (status) {
    case 'QUEUED':
      label = 'Queued'
      color = 'default'
      break
    case 'PREPROCESSING':
      label = 'Preprocessing'
      color = 'info'
      break
    case 'OCR_RUNNING':
      label = 'OCR running'
      color = 'info'
      break
    case 'MAPPING':
      label = 'Mapping'
      color = 'info'
      break
    case 'VALIDATING':
      label = 'Validating'
      color = 'info'
      break
    case 'PENDING_REVIEW':
      label = 'Needs review'
      color = 'warning'
      break
    case 'COMPLETED':
      label = 'Completed'
      color = 'success'
      break
    case 'FAILED':
      label = 'Failed'
      color = 'error'
      break
    case 'REJECTED':
      label = 'Rejected'
      color = 'error'
      break
    case 'CANCELLED':
      label = 'Cancelled'
      color = 'default'
      break
    default:
      label = status.replace(/_/g, ' ')
      color = 'default'
  }

  return <Chip size="small" variant="outlined" label={label} color={color} sx={{ fontWeight: 600 }} />
}