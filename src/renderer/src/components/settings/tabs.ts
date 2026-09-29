/**
 * The Settings rail (v4.0, S1): every tab, its group, its one-line
 * description and its icon, in the order the rail shows them. One table, so
 * the rail, the header, the search and the deep links agree on what a tab is.
 *
 * Keys are stable across renames — `openSettingsAt('models')` keeps working
 * when the rail says Roles.
 */
export type SettingsTabKey =
  | 'connection'
  | 'models'
  | 'general'
  | 'grounding'
  | 'memory'
  | 'tools'
  | 'agent'
  | 'search'
  | 'voice'
  | 'library'
  | 'skills'
  | 'mcp'
  | 'jobs'
  | 'privacy'
  | 'activity'

export type SettingsGroup = 'Setup' | 'Intelligence' | 'Capabilities' | 'Knowledge' | 'Automation' | 'Privacy'

export interface SettingsTab {
  key: SettingsTabKey
  label: string
  description: string
  group: SettingsGroup
  icon: string
  /** Words a reader might type for this tab that its label and description do not contain. */
  keywords?: string[]
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { key: 'connection', label: 'LM Studio', description: 'The local server every model runs on, and what it has loaded.', group: 'Setup', icon: 'plug', keywords: ['connection', 'server', 'url', 'port'] },
  { key: 'models', label: 'Roles', description: 'The roles a message can go to: each one a model, a persona and its own tools; the pipeline they form.', group: 'Setup', icon: 'roles', keywords: ['models', 'slots', 'persona', 'system prompt', 'sampling', 'pipeline', 'collaborative', 'chain'] },
  { key: 'general', label: 'Appearance & chat', description: 'How the window looks and what a reply shows.', group: 'Setup', icon: 'sliders', keywords: ['general', 'theme', 'font', 'vibe'] },
  { key: 'grounding', label: 'Grounding & checks', description: 'What the app does before, after and across replies to keep them honest.', group: 'Intelligence', icon: 'check', keywords: ['second opinion', 'claims', 'verification', 'ledger', 'playbooks'] },
  { key: 'memory', label: 'Memory', description: 'What the app remembers between conversations, and the documents it can recall.', group: 'Intelligence', icon: 'memory', keywords: ['embeddings', 'recall', 'knowledge base'] },
  { key: 'tools', label: 'Tools', description: 'What a model may do beyond words: files, the web, calculators, the sandbox.', group: 'Capabilities', icon: 'tools', keywords: ['grants', 'workbench', 'python', 'working directory'] },
  { key: 'agent', label: 'Agent', description: 'How far a task in a folder may go without asking, and the sigma command.', group: 'Capabilities', icon: 'agent', keywords: ['cli', 'sigma', 'permissions', 'steps'] },
  { key: 'search', label: 'Search & research', description: 'Which search provider the web tools use, and how deep research goes.', group: 'Capabilities', icon: 'search', keywords: ['brave', 'searxng', 'duckduckgo', 'deep research'] },
  { key: 'voice', label: 'Voice', description: 'Replies read aloud, and push-to-talk through whisper.cpp.', group: 'Capabilities', icon: 'mic', keywords: ['speech', 'tts', 'stt', 'dictation'] },
  { key: 'library', label: 'Library', description: 'Reference packs the model can quote instead of recall.', group: 'Knowledge', icon: 'book', keywords: ['packs', 'zim', 'reference'] },
  { key: 'skills', label: 'Skills', description: 'Methods you installed, each fired by its own phrases.', group: 'Knowledge', icon: 'puzzle', keywords: ['playbook', 'install'] },
  { key: 'mcp', label: 'MCP', description: 'Servers on this machine whose tools your models can call.', group: 'Knowledge', icon: 'server', keywords: ['model context protocol', 'servers'] },
  { key: 'jobs', label: 'Jobs', description: 'Questions the app re-asks on a schedule while it is open.', group: 'Automation', icon: 'clock', keywords: ['standing questions', 'schedule', 'digest'] },
  { key: 'privacy', label: 'Privacy', description: 'The promise, the audit, the proxy, and what is allowed to leave this machine.', group: 'Privacy', icon: 'shield', keywords: ['tor', 'proxy', 'audit', 'updates'] },
  { key: 'activity', label: 'Activity', description: 'What the app contacted, what it read, and the session log.', group: 'Privacy', icon: 'activity', keywords: ['network', 'log', 'pages read'] }
]

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ['Setup', 'Intelligence', 'Capabilities', 'Knowledge', 'Automation', 'Privacy']

export function settingsTab(key: SettingsTabKey): SettingsTab {
  const tab = SETTINGS_TABS.find((t) => t.key === key)
  if (!tab) throw new Error(`no settings tab ${key}`)
  return tab
}

/** Tabs whose label, description or keywords start a word with every word of the query. Empty query: every tab. */
export function filterTabs(query: string): SettingsTab[] {
  const words = queryWords(query)
  if (words.length === 0) return [...SETTINGS_TABS]
  return SETTINGS_TABS.filter((t) => wordsMatch(words, `${t.label} ${t.description} ${(t.keywords ?? []).join(' ')} ${t.key}`))
}

export function queryWords(query: string): RegExp[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'))
}

/** Every query word starts some word of the text — so "tor" finds Tor and not calculators. */
export function wordsMatch(words: readonly RegExp[], text: string): boolean {
  return words.every((w) => w.test(text))
}
