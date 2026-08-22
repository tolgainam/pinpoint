/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 100: '#e0e7ff', 500: '#6366f1', 900: '#312e81' },
        ink: '#0b0b0f',
      },
      spacing: { 1: '4px', 2: '8px', 3: '12px', 6: '24px' },
      borderRadius: { card: '14px' },
      fontSize: { tiny: ['11px', { lineHeight: '16px' }], body: ['15px', { lineHeight: '23px' }] },
    },
  },
  plugins: [],
}
