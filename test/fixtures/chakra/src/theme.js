import { extendTheme } from '@chakra-ui/react'

export default extendTheme({
  colors: {
    brand: { 50: '#e6f6ff', 500: '#0087d1', 900: '#003354' },
  },
  space: { 1: '4px', 2: '8px', 4: '16px', 8: '32px' },
  radii: { card: '12px' },
  fontSizes: { sm: '14px', md: '16px' },
})
