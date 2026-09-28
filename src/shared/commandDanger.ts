/**
 * Command shapes that are destructive even when the user means well. They
 * still can run — the user is in charge — but the confirmation dialog spells
 * out the danger instead of presenting them as routine.
 *
 * v3.0: lifted out of the terminal tool (pure, no Electron) so the agent's
 * run_command and the `sigma` CLI warn from the same list, and widened for
 * what an agent reaches for: Windows' own recursive deletes, and the git
 * commands that throw away work nobody committed or rewrite a shared branch.
 */
export const DANGEROUS_COMMAND_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'recursive force delete', re: /\brm\s+[^\n]*-[a-zA-Z]*[rf][a-zA-Z]*\s/ },
  { label: 'recursive delete (Windows)', re: /\b(?:rd|rmdir)\s+[^\n]*\/s\b|\bdel\s+[^\n]*\/s\b|\bRemove-Item\b[^\n]*-Recurse/i },
  { label: 'writes directly to a disk device', re: /\bdd\b[^\n]*\bof=\/dev\// },
  { label: 'disk format / partition', re: /\b(mkfs|fdisk|diskpart|newfs)[.\w]*\b|\bformat\s+[a-z]:/i },
  { label: 'pipes a remote script into a shell', re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b|\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*iex\b/i },
  { label: 'fork bomb shape', re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/ },
  { label: 'broad permission change', re: /\bchmod\s+(-R\s+)?777\s+[~/]/ },
  { label: 'system-wide removal', re: /\brm\s+[^\n]*-[a-zA-Z]*[rf][a-zA-Z]*\s+(--no-preserve-root\s+)?[/~]/ },
  { label: 'discards uncommitted work', re: /\bgit\s+(?:reset\s+[^\n]*--hard|clean\s+[^\n]*-[a-zA-Z]*f|checkout\s+(?:--\s+)?\.(?:\s|$)|restore\s+[^\n]*\.(?:\s|$)|stash\s+(?:drop|clear))/ },
  { label: 'rewrites a remote branch', re: /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/ }
]

export function dangerousCommandWarning(command: string): string | null {
  const hits = DANGEROUS_COMMAND_PATTERNS.filter((p) => p.re.test(command)).map((p) => p.label)
  return hits.length > 0 ? `⚠️ Potentially destructive: ${hits.join('; ')}.` : null
}
