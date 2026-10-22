import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#0b6674', dark: '#064552', light: '#5fa8af' },
    secondary: { main: '#f2a93b', dark: '#b66f08' },
    background: { default: '#f4f7f8', paper: '#ffffff' },
    text: { primary: '#132b32', secondary: '#5b7077' },
    success: { main: '#198765' },
    warning: { main: '#c97808' },
    error: { main: '#b9383c' },
  },
  typography: {
    fontFamily: 'Inter, Aptos, Segoe UI, sans-serif',
    h1: { fontSize: '2rem', fontWeight: 750, letterSpacing: '-0.035em' },
    h2: { fontSize: '1.35rem', fontWeight: 730, letterSpacing: '-0.02em' },
    h3: { fontSize: '1.05rem', fontWeight: 700 },
    button: { fontWeight: 700, textTransform: 'none' },
  },
  shape: { borderRadius: 12 },
  components: {
    MuiCard: { styleOverrides: { root: { border: '1px solid #dde7e9', boxShadow: '0 8px 30px rgba(16, 47, 56, .055)' } } },
    MuiButton: { styleOverrides: { root: { borderRadius: 10, paddingInline: 18 } } },
    MuiChip: { styleOverrides: { root: { fontWeight: 700 } } },
  },
})
