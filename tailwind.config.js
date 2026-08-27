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
         *
         * Legible means measured: primary, secondary and tertiary each clear
         * 4.5:1 on both canvases (test/styleCheck.ts asserts it). `muted` does
         * not and is not meant to — it is decorative and disabled states only,
         * so prose that needs the faintest tier takes `tertiary`.
         */
        ink: {
          DEFAULT: 'var(--text-primary)',
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          muted: 'var(--text-muted)',
          /*
           * Status ink. Same rule as the neutral tiers above, for the same
           * reason: a raw palette step (`text-amber-600`, `text-red-500`) is
           * one colour for two themes, so it can only be legible in one of
           * them — and the sites that reached for one are exactly the lines
           * that report a failure, a warning, or something the app could not
           * verify. Reader-facing status prose goes through these; the guard
           * in test/chromeContrastCheck.ts refuses the raw steps.
           *
           * Surfaces, not ink, carry the hue: keep `bg-amber-500/10` and
           * `border-amber-500/30` as they are. Only the text moves.
           */
          danger: 'var(--text-danger)',
          warn: 'var(--text-warn)',
          ok: 'var(--text-ok)'
        }
      }
    }
  },
  plugins: []
}
