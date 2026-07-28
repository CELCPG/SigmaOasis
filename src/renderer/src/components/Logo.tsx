/**
 * The Sigma Oasis mark: a sigma glyph over calm water on a teal gradient,
 * with a sand-gold ripple — matching the app icon (build/icon.png).
 * SVG so it stays crisp at sidebar, onboarding, and empty-state sizes.
 */
export function Logo({ size = 20, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label="Sigma Oasis"
    >
      <defs>
        <linearGradient id="so-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#14b8a6" />
          <stop offset="100%" stopColor="#155e75" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#so-bg)" />
      <text
        x="24"
        y="30"
        textAnchor="middle"
        fontSize="26"
        fontWeight="700"
        fill="#ecfeff"
        fontFamily="Georgia, 'Times New Roman', serif"
      >
        Σ
      </text>
      <path
        d="M10 37 q7 -4 14 0 t14 0"
        fill="none"
        stroke="#f0b429"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}
