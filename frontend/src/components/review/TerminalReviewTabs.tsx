import React from 'react'
import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'

interface FieldValue {
  value: string | number | null
  confidence?: number
  source?: string
  page?: number
}

interface TerminalReviewTabsProps {
  draft: Record<string, unknown> | null
  disabled?: boolean
  onChange: (updatedDraft: Record<string, unknown>) => void
}

const TABLE_COLUMNS: { key: string; label: string; width?: string | number }[] = [
  { key: 'chargeCode', label: 'Charge Code', width: 140 },
  { key: 'description', label: 'Description', width: 220 },
  { key: 'costType', label: 'Cost Type', width: 120 },
  { key: 'chargeFamily', label: 'Family', width: 100 },
  { key: 'size', label: 'Size', width: 80 },
  { key: 'containerType', label: 'Type', width: 80 },
  { key: 'ladenEmpty', label: 'Laden/Empty', width: 110 },
  { key: 'quantity', label: 'Qty', width: 90 },
  { key: 'unitPrice', label: 'Unit Rate', width: 110 },
  { key: 'amount', label: 'Gross Amt', width: 120 },
  { key: 'discount', label: 'Discount', width: 100 },
]

export function TerminalReviewTabs({ draft, disabled = false, onChange }: TerminalReviewTabsProps) {
  const lineItems = Array.isArray(draft?.lineItems) ? (draft.lineItems as Record<string, FieldValue>[]) : []

  if (!lineItems.length) {
    return (
      <Box py={6} textAlign="center">
        <Typography color="text.secondary">No line items available for this invoice.</Typography>
      </Box>
    )
  }

  const handleCellChange = (rowIndex: number, fieldKey: string, newValue: string) => {
    if (!draft) return

    const updatedLines = [...lineItems]
    const existingField = updatedLines[rowIndex]?.[fieldKey] || {}

    updatedLines[rowIndex] = {
      ...updatedLines[rowIndex],
      [fieldKey]: {
        ...existingField,
        value: newValue,
        source: 'review',
        confidence: 1,
      },
    }

    onChange({
      ...draft,
      lineItems: updatedLines,
    })
  }

  return (
    <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 'calc(100vh - 380px)', minHeight: 340 }}>
      <Table stickyHeader size="small" aria-label="Terminal Line Items Table">
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 48, fontWeight: 700 }}>#</TableCell>
            {TABLE_COLUMNS.map((col) => (
              <TableCell key={col.key} sx={{ width: col.width, fontWeight: 700, whiteSpace: 'nowrap' }}>
                {col.label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {lineItems.map((row, idx) => (
            <TableRow key={idx} hover>
              <TableCell sx={{ color: 'text.secondary', fontWeight: 600 }}>{idx + 1}</TableCell>
              {TABLE_COLUMNS.map((col) => {
                const cell = row[col.key] || row[col.key === 'amount' ? 'lineTotal' : col.key]
                const val = cell?.value ?? ''
                const conf = cell?.confidence ?? 1
                const isLowConfidence = conf < 0.7 && val !== ''

                return (
                  <TableCell
                    key={col.key}
                    sx={{
                      backgroundColor: isLowConfidence ? 'rgba(237, 108, 2, 0.08)' : 'inherit',
                      p: 1,
                    }}
                  >
                    <TextField
                      variant="standard"
                      fullWidth
                      size="small"
                      value={val}
                      disabled={disabled}
                      onChange={(e) => handleCellChange(idx, col.key, e.target.value)}
                      slotProps={{
                        input: {
                          disableUnderline: disabled,
                          style: {
                            fontSize: '0.84rem',
                            fontWeight: isLowConfidence ? 650 : 400,
                            color: isLowConfidence ? '#d97706' : 'inherit',
                          },
                        },
                      }}
                    />
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}