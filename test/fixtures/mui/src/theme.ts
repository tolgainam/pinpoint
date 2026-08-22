import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1976d2', dark: '#115293' },
    secondary: { main: '#9c27b0' },
    error: { main: '#d32f2f' },
  },
  shape: { borderRadius: 8 },
  typography: { fontFamily: 'Inter, sans-serif', fontSize: 14 },
})
