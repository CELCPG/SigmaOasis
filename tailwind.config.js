/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#3b82f6',
          hover: '#2563eb'
        },
        panel: {
          light: '#ffffff',
          dark: '#16181d'
        },
        base: {
          light: '#f4f4f5',
          dark: '#0f1115'
        }
      }
    }
  },
  plugins: []
}
