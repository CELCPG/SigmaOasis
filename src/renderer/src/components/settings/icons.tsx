/**
 * The rail's icons (v4.0, S1): sixteen line glyphs on a 24-unit grid, one
 * stroke, currentColor — so they read in the tertiary ink beside an inactive
 * tab and in the accent beside the active one. Drawn here rather than pulled
 * from an icon package: sixteen paths are not a dependency.
 */
const PATHS: Record<string, string> = {
  plug: 'M9 3v4M15 3v4M6 7h12l-1 5a5 5 0 0 1-10 0L6 7zM12 17v4',
  roles: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a5 5 0 0 1 10 0M11 20a5 5 0 0 1 10 0',
  sliders: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0M14 4v4M6 10v4M16 16v4',
  check: 'M4 12l3 3 5-5M13 8l3 3 5-5M4 19h16',
  pipeline: 'M4 6h4v4H4zM10 14h4v4h-4zM16 6h4v4h-4zM8 8h8M12 10v4',
  memory: 'M9 4a4 4 0 0 0-4 4v1a3 3 0 0 0 0 6v1a4 4 0 0 0 4 4h1V4H9zM15 4a4 4 0 0 1 4 4v1a3 3 0 0 1 0 6v1a4 4 0 0 1-4 4h-1V4h1z',
  tools: 'M14 4l6 6-8 8H8v-4l6-6zM5 19l-1 1M15 5l4 4',
  agent: 'M12 3v3M8 6h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3zM9 12h.01M15 12h.01M9 15h6M3 11v3M21 11v3',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
  book: 'M4 5a2 2 0 0 1 2-2h6v16H6a2 2 0 0 0-2 2V5zM20 5a2 2 0 0 0-2-2h-6v16h6a2 2 0 0 1 2 2V5z',
  puzzle: 'M9 4h4a2 2 0 1 1 2 2h1a2 2 0 0 1 2 2v3a2 2 0 1 0 0 4v3a2 2 0 0 1-2 2h-3a2 2 0 1 0-4 0H6a2 2 0 0 1-2-2v-4a2 2 0 1 1 0-4V8a2 2 0 0 1 2-2h1a2 2 0 1 1 2-2z',
  server: 'M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2',
  shield: 'M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3zM9 12l2 2 4-4',
  activity: 'M3 12h4l3-7 4 14 3-7h4'
}

export function TabIcon({ name, className = '' }: { name: string; className?: string }): JSX.Element {
  const d = PATHS[name] ?? PATHS.sliders
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`}>
      <path d={d} />
    </svg>
  )
}
