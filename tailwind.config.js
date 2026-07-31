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
          glow: '#4fffd1',
          /* Accent text that stays legible in both themes — see --accent-ink. */
          ink: 'var(--accent-ink)'
        },
        panel: {
          light: '#ffffff',
          dark: '#0a0a0c'
        },
        base: {
          light: '#f4f4f5',
          dark: '#000000'
        },
        /*
         * Semantic ink, resolved from the CSS variables in assets/index.css so
         * text stays legible in both themes without a `dark:` variant. The
         * variables carry their own alpha, so opacity modifiers such as
         * `text-ink-secondary/50` will NOT work — pick a lighter tier instead.
         */
        ink: {
          DEFAULT: 'var(--text-primary)',
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          muted: 'var(--text-muted)'
        }
      }
    }
  },
  plugins: []
}
