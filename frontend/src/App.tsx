import { useState } from 'react'
import { NavLink, Route, Routes, useLocation } from 'react-router-dom'
import DashboardRounded from '@mui/icons-material/DashboardRounded'
import FileUploadRounded from '@mui/icons-material/FileUploadRounded'
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded'
import FactCheckRounded from '@mui/icons-material/FactCheckRounded'
import MenuRounded from '@mui/icons-material/MenuRounded'
import TerminalRounded from '@mui/icons-material/TerminalRounded'
import { AppBar, Avatar, Box, Drawer, IconButton, Stack, Toolbar, Typography } from '@mui/material'
import { DashboardPage } from './pages/DashboardPage'
import { UploadPage } from './pages/UploadPage'
import { InvoicesPage } from './pages/InvoicesPage'
import { ReviewPage } from './pages/ReviewPage'

const nav = [
  { label: 'Overview', to: '/', icon: <DashboardRounded /> },
  { label: 'Submit invoices', to: '/submit', icon: <FileUploadRounded /> },
  { label: 'Terminal invoices', to: '/terminal', icon: <TerminalRounded /> },
  { label: 'All invoices', to: '/invoices', icon: <ReceiptLongRounded /> },
  { label: 'Review queue', to: '/invoices?status=PENDING_REVIEW', icon: <FactCheckRounded /> },
]

export function App() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  const sidebar = (
    <Box className="sidebar">
      <Stack direction="row" alignItems="center" spacing={1.4} className="brand">
        <Box className="brand-mark">IE</Box>
        <Box><Typography fontWeight={800} lineHeight={1.05}>Invoice Intelligence</Typography><Typography variant="caption" color="rgba(255,255,255,.62)">Verification workspace</Typography></Box>
      </Stack>
      <Stack spacing={.5} sx={{ px: 1.5, mt: 3 }}>
        {nav.map(item => (
          <NavLink 
            key={item.label} 
            to={item.to} 
            onClick={() => setMobileOpen(false)} 
            className={({ isActive }) => {
              let isCurrent = isActive;
              if (item.to === '/') {
                isCurrent = location.pathname === '/';
              } else if (item.to === '/invoices') {
                // Prevent "All invoices" from highlighting when query params exist
                isCurrent = location.pathname === '/invoices' && !location.search.includes('status=PENDING_REVIEW');
              } else if (item.to.includes('?')) {
                // Explicitly require the query param for "Review queue"
                const [path, search] = item.to.split('?');
                isCurrent = location.pathname === path && location.search.includes(search);
              }
              return `nav-item ${isCurrent ? 'active' : ''}`;
            }}
          >
            {item.icon}<span>{item.label}</span>
          </NavLink>
        ))}
      </Stack>
      <Box className="sidebar-foot"><Box className="pulse"/><Box><Typography variant="caption" color="white" fontWeight={700}>Local demo environment</Typography><Typography variant="caption" display="block" color="rgba(255,255,255,.55)">No invoice data is sent to Git</Typography></Box></Box>
    </Box>
  )

  return <Box sx={{ display: 'flex', minHeight: '100vh' }}>
    <AppBar position="fixed" color="inherit" elevation={0} className="mobile-bar"><Toolbar><IconButton onClick={() => setMobileOpen(true)}><MenuRounded /></IconButton><Typography fontWeight={800}>IES</Typography></Toolbar></AppBar>
    <Drawer variant="permanent" className="desktop-drawer" open>{sidebar}</Drawer>
    <Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }}>{sidebar}</Drawer>
    <Box component="main" className="main-content">
      <Box className="topline"><Box><Typography variant="caption" color="text.secondary" fontWeight={700}>GLOBAL CAPABILITY CENTRE</Typography></Box><Stack direction="row" alignItems="center" spacing={1.2}><Box textAlign="right"><Typography variant="body2" fontWeight={750}>Local reviewer</Typography><Typography variant="caption" color="text.secondary">Demo access</Typography></Box><Avatar sx={{ bgcolor: 'primary.main', width: 36, height: 36 }}>LR</Avatar></Stack></Box>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/submit" element={<UploadPage invoiceType="STANDARD" />} />
        <Route path="/terminal" element={<UploadPage invoiceType="TES" />} />
        <Route path="/invoices" element={<InvoicesPage />} />
        <Route path="/invoices/:id" element={<ReviewPage />} />
      </Routes>
    </Box>
  </Box>
}