/**
 * The front door (v4.0, track F): what the first screen offers, decided here
 * so node:test can pin it. Three doors, a strip of what the reader left off,
 * and at most six cards — each a capability this machine has, chosen from
 * what is enabled, greyed with the setting that turns it on when it is not.
 */
import type { AppSettings, Conversation, ConnectionStatus } from '../types'

export type CardFamily = 'files' | 'code' | 'search' | 'memory' | 'library' | 'shopping' | 'agent'

/** The style guide's tool colours: search teal, code amber, memory lavender, files coral. */
export const FAMILY_COLOR: Record<CardFamily, string> = {
  files: 'var(--accent-coral)',
  code: 'var(--accent-amber)',
  search: 'var(--accent-teal)',
  memory: 'var(--accent-lavender)',
  library: 'var(--accent-lavender)',
  shopping: 'var(--accent-teal)',
  agent: 'var(--accent-teal)'
}

export interface FrontDoorCard {
  id: string
  icon: string
  title: string
  /** The sentence that goes into the composer, or the task an agent chat starts with. */
  prompt: string
  family: CardFamily
  /** What runs: a tool name, or "agent". Shown as the chip. */
  runs: string
  /** Starts an agent chat on a folder the reader picks, with `prompt` as its first task. */
  agent?: boolean
  enabled: boolean
  /** When not enabled: why, in a few words, and the Settings target that turns it on. */
  reason?: string
  link?: string
}

export interface MachineState {
  settings: AppSettings
  /** The Workbench runtime is present (Pyodide fetched). */
  workbench: boolean
  /** Memory holds at least one source or chunk. */
  memoryHasAnything: boolean
  /** At least one library pack is installed. */
  libraryHasPacks: boolean
}

/** The search provider is configured enough to answer: SearXNG needs an address; the others need nothing here. */
export function searchConfigured(s: AppSettings): boolean {
  return s.search.provider !== 'searxng' || Boolean(s.search.searxngUrl.trim())
}

const ALL_CARDS = (m: MachineState): FrontDoorCard[] => {
  const t = m.settings.tools
  return [
    {
      id: 'summarize',
      icon: '📄',
      title: 'Summarize a document I drop in',
      prompt: 'Summarize the document I’m about to attach and pull out every decision and deadline.',
      family: 'files',
      runs: 'analyze_file',
      enabled: true
    },
    {
      id: 'spreadsheet',
      icon: '🧮',
      title: 'Check the math in this spreadsheet',
      prompt: 'Check the arithmetic in the spreadsheet I’m attaching: recompute every total and flag anything that does not add up.',
      family: 'code',
      runs: 'run_python',
      enabled: t.run_python && m.workbench,
      reason: !t.run_python ? 'the Python sandbox is off' : 'the Python runtime is not installed',
      link: 'tools.run_python'
    },
    {
      id: 'research',
      icon: '🔎',
      title: 'Research this, with the sources',
      prompt: 'Research this properly and show me the sources you actually used: ',
      family: 'search',
      runs: 'deep_research',
      enabled: t.deep_research && t.web_search && searchConfigured(m.settings),
      reason: !t.deep_research || !t.web_search ? 'the web tools are off' : 'no search provider is set',
      link: !t.deep_research || !t.web_search ? 'tools.deep_research' : 'search.provider'
    },
    {
      id: 'tidy',
      icon: '🗂️',
      title: 'Tidy a folder',
      prompt: 'Tidy this folder: group the files by type into folders, name the folders plainly, and show me the plan before moving anything.',
      family: 'agent',
      runs: 'agent',
      agent: true,
      enabled: true
    },
    {
      id: 'fix',
      icon: '🧪',
      title: 'Fix the failing test',
      prompt: 'Find the failing test, work out why it fails, fix the cause, and run the tests until they pass.',
      family: 'agent',
      runs: 'agent',
      agent: true,
      enabled: true
    },
    {
      id: 'memory',
      icon: '🧠',
      title: 'What do you remember about me?',
      prompt: 'What do you remember about me and my projects so far? List it, with where each memory came from.',
      family: 'memory',
      runs: 'memory_search',
      enabled: t.memory_search && m.memoryHasAnything,
      reason: !t.memory_search ? 'memory search is off' : 'nothing is remembered yet',
      link: !t.memory_search ? 'tools.memory_search' : 'memory.knowledge'
    },
    {
      id: 'library',
      icon: '📚',
      title: 'Look something up in the library',
      prompt: 'Look this up in the reference library and quote the passage you used: ',
      family: 'library',
      runs: 'reference_lookup',
      enabled: t.reference_lookup && m.libraryHasPacks,
      reason: !t.reference_lookup ? 'the library tool is off' : 'no pack is installed',
      link: !t.reference_lookup ? 'tools.reference_lookup' : 'library.packs'
    },
    {
      id: 'prices',
      icon: '🏷️',
      title: 'Compare prices for something',
      prompt: 'Compare prices for this across a few sellers and tell me which is the best deal today: ',
      family: 'shopping',
      runs: 'shop_compare',
      enabled: t.shop_compare,
      reason: 'the shopping tools are off',
      link: 'tools.shop_compare'
    }
  ]
}

/**
 * At most `max` cards: every enabled one in the table's order, then the
 * disabled ones (greyed, with their setting) until the count is reached — so
 * a fresh install sees what it could turn on, and a full one sees what works.
 */
export function chooseCards(m: MachineState, max = 6): FrontDoorCard[] {
  const all = ALL_CARDS(m)
  const on = all.filter((c) => c.enabled)
  const off = all.filter((c) => !c.enabled)
  return [...on, ...off].slice(0, max)
}

/** The greeting for the hour, in the reader's clock. */
export function greeting(hour: number): string {
  if (hour < 5) return 'Good evening'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export interface PickUp {
  recent: Conversation[]
  digest: Conversation | null
}

/**
 * What the reader left off: the two most recent conversations with a message
 * in them (not this empty one), and the newest digest of the last day.
 */
export function pickUp(conversations: readonly Conversation[], excludeId: string | null, now: number): PickUp {
  const withMessages = conversations.filter((c) => c.id !== excludeId && c.messages.length > 0 && !c.ephemeral).sort((a, b) => b.updatedAt - a.updatedAt)
  const digest = withMessages.find((c) => c.title.startsWith('📬') && now - c.updatedAt < 24 * 3600_000) ?? null
  const recent = withMessages.filter((c) => c !== digest).slice(0, 2)
  return { recent, digest }
}

/** "3m ago", "2h ago", "yesterday", or the date. */
export function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(then).toLocaleDateString()
}

/** Which of the first screen's states the machine is in. */
export type MachineReady = { kind: 'ready' } | { kind: 'offline'; baseUrl: string } | { kind: 'no-role' }

export function readiness(connection: ConnectionStatus, settings: AppSettings): MachineReady {
  if (connection !== 'online') return { kind: 'offline', baseUrl: settings.baseUrl }
  if (!settings.models.some((m) => m.enabled && m.modelId)) return { kind: 'no-role' }
  return { kind: 'ready' }
}
