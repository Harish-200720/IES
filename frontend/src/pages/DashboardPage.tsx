import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded'
import PendingActionsRounded from '@mui/icons-material/PendingActionsRounded'
import SpeedRounded from '@mui/icons-material/SpeedRounded'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Grid2,
  Stack,
  Typography,
} from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getDashboard, getInvoices } from '../api'
import { StatusChip } from '../components/StatusChip'
import type { DashboardData } from '../types'

type DashboardResponse = DashboardData & {
  counts?: Array<{ status: string; count: number | string }>
}

export function DashboardPage() {
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: getDashboard, refetchInterval: 5000 })
  const invoices = useQuery({ queryKey: ['invoices', 'recent'], queryFn: () => getInvoices(), refetchInterval: 5000 })

  if (dashboard.isLoading) {
    return (
      <Box display="grid" minHeight="60vh" sx={{ placeItems: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }

  if (dashboard.isError) {
    return (
      <Alert severity="error">
        The API is not reachable. Ensure the backend Fastify server is running on port 8080.
      </Alert>
    )
  }

  const rawData: DashboardResponse = dashboard.data ?? {} as DashboardResponse
  const statusCounts = Array.isArray(rawData.counts)
    ? rawData.counts.reduce((acc: any, cur: any) => ({ ...acc, [cur.status]: Number(cur.count) }), {})
    : {}
  const totalInvoices = Object.values(statusCounts).reduce((a: number, b: any) => a + Number(b), 0) as number

  const cards = [
    { label: 'Invoices received', value: rawData.total ?? totalInvoices, icon: <SpeedRounded />, tone: 'teal' },
    { label: 'Completed', value: rawData.completed ?? (statusCounts['COMPLETED'] || 0), icon: <CheckCircleRounded />, tone: 'green' },
    { label: 'Awaiting review', value: rawData.pendingReview ?? (statusCounts['PENDING_REVIEW'] || 0), icon: <PendingActionsRounded />, tone: 'amber' },
    { label: 'Failed', value: rawData.failed ?? (statusCounts['FAILED'] || 0), icon: <ErrorOutlineRounded />, tone: 'red' },
  ]

  const invoiceList: any[] = (Array.isArray(invoices.data) ? invoices.data : invoices.data?.content) || []

  return (
    <Stack spacing={3.2}>
      <Box className="page-heading">
        <Box>
          <Typography variant="h1">Invoice operations</Typography>
          <Typography color="text.secondary" mt={0.7}>
            Track extraction health, clear exceptions and protect downstream finance workflows.
          </Typography>
        </Box>
        <Button component={Link} to="/submit" variant="contained" endIcon={<ArrowForwardRounded />}>
          Submit invoices
        </Button>
      </Box>

      <Grid2 container spacing={2}>
        {cards.map((card) => (
          <Grid2 key={card.label} size={{ xs: 12, sm: 6, lg: 3 }}>
            <Card>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Box>
                    <Typography variant="caption" color="text.secondary" fontWeight={750}>
                      {card.label.toUpperCase()}
                    </Typography>
                    <Typography fontSize="2rem" fontWeight={780} mt={0.5}>
                      {card.value}
                    </Typography>
                  </Box>
                  <Box className={`metric-icon ${card.tone}`}>{card.icon}</Box>
                </Stack>
              </CardContent>
            </Card>
          </Grid2>
        ))}
      </Grid2>

      <Grid2 container spacing={2.4}>
        <Grid2 size={{ xs: 12 }}>
          <Card>
            <CardContent sx={{ p: 3 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2.2}>
                <Box>
                  <Typography variant="h2">Recent invoices</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Latest processing activity
                  </Typography>
                </Box>
                <Button component={Link} to="/invoices">
                  View all
                </Button>
              </Stack>
              <Stack divider={<Box className="divider" />}>
                {invoiceList.slice(0, 8).map((job: any) => (
                  <Stack
                    key={job.id}
                    component={Link}
                    to={`/invoices/${job.id}`}
                    className="invoice-row"
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <Box minWidth={0}>
                      <Typography fontWeight={720} noWrap>
                        {job.original_filename || job.filename}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {new Date(job.created_at || job.createdAt).toLocaleString()} · {job.engine || 'Waiting for worker'}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={2} alignItems="center">
                      <Typography variant="body2" color="text.secondary">
                        {job.confidence == null ? '—' : `${Math.round(job.confidence * 100)}%`}
                      </Typography>
                      <StatusChip status={job.status} />
                    </Stack>
                  </Stack>
                ))}
                {!invoiceList.length && (
                  <Box py={6} textAlign="center">
                    <Typography color="text.secondary">No invoices yet. Submit a batch to begin.</Typography>
                  </Box>
                )}
              </Stack>
            </CardContent>
          </Card>
        </Grid2>
      </Grid2>
    </Stack>
  )
}