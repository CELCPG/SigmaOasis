/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#0d9488',
          hover: '#0f766e'
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
