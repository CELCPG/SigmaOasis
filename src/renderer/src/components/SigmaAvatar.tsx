/**
 * The Σ identity avatar: teal gradient glass tile with the sigma glyph,
 * per the Apple Glass style guide (40×40, 14px radius, inner top highlight,
 * teal outer glow). Used on assistant messages in place of a bare name.
 * `active` (v1.7): the answering model's avatar breathes while it streams.
 */
export function SigmaAvatar({ size = 40, active = false }: { size?: number; active?: boolean }): JSX.Element {
  return (
    <span
      className={`sigma-avatar ${active ? 'sigma-avatar--active' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 40 40" width={size} height={size}>
        <defs>
          <linearGradient id="sigma-avatar-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgba(0,212,170,0.8)" />
            <stop offset="100%" stopColor="rgba(0,143,107,0.8)" />
          </linearGradient>
        </defs>
        <rect width="40" height="40" rx="14" fill="url(#sigma-avatar-bg)" />
        <rect width="40" height="40" rx="14" fill="none" stroke="rgba(0,212,170,0.3)" strokeWidth="1" />
        <rect x="1" y="1" width="38" height="12" rx="6" fill="rgba(255,255,255,0.08)" />
        <text
          x="20"
          y="27"
          textAnchor="middle"
          fontSize="20"
          fontWeight="700"
          fill="#ffffff"
          fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif"
        >
          Σ
        </text>
      </svg>
    </span>
  )
}
