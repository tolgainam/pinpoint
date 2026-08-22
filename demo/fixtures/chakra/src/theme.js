import { extendTheme } from '@chakra-ui/react'

/**
 * The theme, as a plain object literal. Nothing here is computed — which is what lets
 * the probe read it as text instead of importing a file that would pull @chakra-ui and
 * @emotion into the bridge's process.
 */
export default extendTheme({
  colors: {
    brand: {
      50: '#f5f3ff',
      100: '#ede9fe',
      300: '#c4b5fd',
      500: '#8b5cf6',
      600: '#7c3aed',
      700: '#6d28d9',
    },
    ink: {
      900: '#1a1b25',
      700: '#3b3d4d',
      500: '#6b6e85',
    },
    line: '#e6e4f0',
    surface: '#ffffff',
    canvas: '#faf9fe',
  },

  space: {
    1: '0.25rem',
    2: '0.5rem',
    3: '0.75rem',
    4: '1rem',
    5: '1.25rem',
    6: '1.5rem',
    8: '2rem',
    10: '2.5rem',
    12: '3rem',
    16: '4rem',
  },

  fontSizes: {
    xs: '0.75rem',
    sm: '0.875rem',
    md: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '4xl': '2.25rem',
  },

  radii: {
    sm: '4px',
    md: '8px',
    lg: '12px',
    xl: '20px',
    full: '9999px',
  },

  fonts: {
    heading: 'Inter, ui-sans-serif, system-ui, sans-serif',
    body: 'Inter, ui-sans-serif, system-ui, sans-serif',
  },
})
