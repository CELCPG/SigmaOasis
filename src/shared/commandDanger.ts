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

/**
 * v4.1 (F2): command shapes that obviously reach the network on their own.
 *
 * A command the agent, a hook or the chat's terminal tool runs is a child
 * process with sockets of its own: it does not pass through `auditedFetch`,
 * the egress allowlist or the proxy, so the network activity log cannot see
 * what it sends. The app cannot sandbox that; it can say so — in the approval,
 * and with a line in the log that the command ran.
 *
 * Conservative on purpose: the obvious (downloaders, git remotes, package
 * installs, remote shells, a literal non-loopback URL), not a promise that an
 * unmarked command stays on the machine — `npm test` can fetch too. Short,
 * ambiguous program names (`ssh`, `nc`) count only where a command starts —
 * the line's start, after a separator or pipe, or after sudo — so a folder
 * called `ssh/` is not a remote shell. Every pattern is linear: no repeat
 * holds a group that can match the same text two ways.
 */
export const NETWORK_COMMAND_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'downloads or calls a URL', re: /\b(?:curl|wget|aria2c|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|bitsadmin)\b/i },
  { label: 'talks to a git remote', re: /\bgit\s+(?:-[Cc]\s+\S+\s+)*(?:clone|fetch|pull|push|ls-remote|remote\s+update|submodule\s+(?:add|update|sync))\b/ },
  {
    label: 'installs or publishes packages',
    re: /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|update|upgrade|publish|dlx|create)|npx\s+(?:-y|--yes)|(?:pip3?|pipx|uv\s+pip)\s+(?:install|download)|(?:python3?|py)(?:\.exe)?\s+-m\s+pip\s+(?:install|download)|uv\s+(?:add|sync)|poetry\s+(?:install|add|update)|conda\s+(?:install|create|update)|cargo\s+(?:install|add|update|fetch|publish)|go\s+(?:get|install|mod\s+download)|gem\s+install|brew\s+(?:install|upgrade|update)|apt(?:-get)?\s+(?:install|update|upgrade)|choco\s+install|winget\s+install|dotnet\s+(?:restore|add\s+package)|docker\s+(?:pull|push|login))\b/i
  },
  { label: 'opens a remote shell or transfer', re: /(?:^|[;&|(]|\bsudo)\s*(?:ssh|scp|sftp|ftp|telnet|rsync|nc|ncat|netcat)(?:\.exe)?(?=\s|$)/i },
  { label: 'names a URL', re: /\b(?:https?|ftp):\/\/(?!localhost\b|127\.|\[::1\])/i }
]

/** The label of every network shape a command has, in list order; empty when none. */
export function networkCommandReasons(command: string): string[] {
  return NETWORK_COMMAND_PATTERNS.filter((p) => p.re.test(command)).map((p) => p.label)
}

/** The line an approval shows for a command that reaches the network; null when no shape matches. */
export function networkCommandNotice(command: string): string | null {
  const hits = networkCommandReasons(command)
  return hits.length > 0 ? `🌐 Reaches the network — not in the network log (${hits.join('; ')}).` : null
}

/**
 * Both notes a command's approval carries, in the shape `AgentHost.approveCommand`
 * takes, so run_command gains the network line with one call (v4.1, F2).
 */
export function commandNotices(command: string): { warning: string | null; network: string | null } {
  return { warning: dangerousCommandWarning(command), network: networkCommandNotice(command) }
}
