/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#00d4aa',
          hover: '#00b895',
          glow: '#4fffd1'
        },
        panel: {
          light: '#ffffff',
          dark: '#0a0a0c'
        },
        base: {
          light: '#f4f4f5',
          dark: '#000000'
        }
      }
    }
  },
  plugins: []
}
