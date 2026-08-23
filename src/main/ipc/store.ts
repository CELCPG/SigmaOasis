import Store from 'electron-store'
import { app, dialog, ipcMain, safeStorage } from 'electron'
import { hostWindow } from './hostWindow'
import { promises as fs } from 'fs'
import { existsSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from './fsAtomic'
import { isLoopbackBaseUrl } from './loopback'

/**
 * Default settings shape. The renderer keeps a mirror of this shape in its
 * Zustand store, but electron-store is the source of truth for persistence.
 */
/**
 * Per-role sampling. Through v0.8.1 the chat path sent no sampling parameters
 * at all, so every role ran at whatever the server defaulted to and there was
 * no way to make one deterministic.
 */
export interface SamplingSettings {
  /** 0–2. 0 is greedy decoding: same prompt, same answer. */
  temperature: number
  /** 0–1 nucleus sampling. 1 disables it. */
  topP: number
  /** Reply length cap. -1 leaves it to the server. */
  maxTokens: number
  /** Fixed RNG seed for reproducible replies; null lets the server choose. */
  seed: number | null
  /**
   * Top-k truncation. -1 follows the model family's published recipe, 0
   * disables it, a positive value is sent as given.
   *
   * v1.5, and new fields rather than new defaults on the old ones: through
   * v1.4 nothing but temperature and top_p reached the wire, so every model ran
   * with top-k off. Qwen3 ships a recipe that assumes top_k 20 and degenerates
   * into repetition without it — and repetition is not only worse text, it is
   * tokens spent to produce worse text. Defaulting to "auto" fixes that for
   * anyone who never opened this panel, while an explicit value always wins.
   */
  topK: number
  /** Minimum-probability floor. -1 follows the family recipe, 0 disables it. */
  minP: number
}

export interface ModelConfig {
  id: string
  modelId: string // the model identifier from LM Studio /v1/models
  roleName: string
  systemPrompt: string
  color: string // 'blue' | 'purple' | 'green' (accent key)
  enabled: boolean
  sampling: SamplingSettings
  /**
   * Context window to budget against, overriding what LM Studio reports.
   * Null means auto (trust the server). Set this when the server under-reports
   * or the model is loaded with a window LM Studio does not advertise, because
   * history compaction triggers off this number.
   */
  contextWindow: number | null
  /**
   * Per-role tool allowlist (v1.3). Absent = all globally-enabled tools; an
   * array — even empty — restricts the slot to the named tools that are also
   * globally enabled.
   */
  tools?: string[]
  /**
   * One-line routing declaration (v1.4): "send me X; don't send me Y". Shown
   * to other models in the consult_model roster and used by the pre-flight
   * router. Absent = the router falls back to the system prompt.
   */
  capability?: string
  /**
   * Structured routing tag (v1.4) the pre-flight classifier matches on.
   * Absent = generalist; the slot is never auto-routed a specialty signal.
   */
  specialty?: 'coding' | 'research' | 'finance' | 'data'
}

export interface ToolToggles {
  read_file: boolean
  write_file: boolean
  list_directory: boolean
  run_terminal_command: boolean
  web_search: boolean
  image_search: boolean
  fetch_webpage: boolean
  date_calculator: boolean
  geo_locate: boolean
  get_current_datetime: boolean
  create_note: boolean
  list_notes: boolean
  read_note: boolean
  memory_save: boolean
  memory_search: boolean
  memory_forget: boolean
  /** v1.5: offline reference library (the Almanac). Local disk + loopback embeddings only. */
  reference_lookup: boolean
  /** v1.6: the Workbench — sandboxed Python (WASM; no network, no real disk). */
  run_python: boolean
  /** v1.6: mechanical profile of an attached CSV/TSV/JSON/XLSX (runs in the same sandbox). */
  analyze_file: boolean
  deep_research: boolean
  finance_calculator: boolean
  shop_requirements: boolean
  shop_compare: boolean
  price_watch: boolean
  /**
   * v1.12: daily market data (stocks, ETFs, indices, futures, crypto pairs).
   * Off by default: each lookup sends the ticker to one pinned public host,
   * which is a disclosure of what you are researching.
   */
  market_data: boolean
}

export interface ShoppingSettings {
  /**
   * Refuse shopping fetches when no proxy is active. On by default: these
   * requests contact commercial sites that log them, and a privacy setting
   * that silently does not cover the case that matters is worse than none.
   */
  requireProxy: boolean
  /** Sellers fetched per comparison (1–5). */
  maxSellers: number
  /** Drop affiliate listicles and content farms from candidate discovery. */
  excludeTierX: boolean
}

export type SearchProviderId = 'searxng' | 'brave' | 'duckduckgo'

export interface SearchSettings {
  /** Which backend serves the web_search tool. */
  provider: SearchProviderId
  /** Base URL of a self-hosted SearXNG instance (loopback recommended). */
  searxngUrl: string
  /** Max results handed to the model per search (1–10). */
  maxResults: number
  /** Show a confirmation dialog with the exact outgoing query before every search. */
  confirmBeforeSearch: boolean
  /**
   * Re-read JavaScript-dependent pages in an offscreen browser when the plain
   * fetch comes back empty. Off by default: it runs a page's scripts, which the
   * static path never does, so it is the user's call.
   */
  useHeadlessRenderer: boolean
}

export interface ResearchSettings {
  /**
   * How much a single deep_research call may spend: searches, fetches, distinct
   * hosts and wall clock. See budgetFor() in deepResearch.ts.
   */
  depth: 'quick' | 'standard' | 'thorough'
  /**
   * Show the full plan — every sub-question and every outgoing query — for
   * approval before anything is sent. Independent of confirmBeforeSearch, since
   * one plan-level gate is more informative than N per-query dialogs.
   */
  confirmPlan: boolean
}

export interface ProxySettings {
  /**
   * Route search, page fetches and rendering through a proxy. SOCKS5 is
   * preferred: Chromium resolves DNS at the proxy, so the local resolver never
   * learns which sites are being read. LM Studio traffic is never proxied.
   */
  mode: 'none' | 'socks5' | 'http'
  host: string
  port: number
}

export interface UpdateSettings {
  /** Periodic background update checks. Off by default — manual "Check now" always works. */
  autoCheck: boolean
}

export interface VoiceSettings {
  autoRead: boolean
  voiceURI: string
  rate: number
}

export interface SttSettings {
  whisperCliPath: string
  whisperModelPath: string
}

export interface MemorySettings {
  autoContext: boolean
  topK: number
  embeddingModel: string
}

export interface SecondOpinionSettings {
  /** Master switch for the critic pass. Off by default. */
  enabled: boolean
  /** Reviewing slot; null = auto (first enabled slot that is not the answerer). */
  criticSlotId: string | null
}

export interface GroundingSettings {
  /**
   * v1.4.6: when the mechanical grounding check finds specifics the turn's own
   * tools do not support — an address in no result, a price from nowhere, a
   * phone number assembled from a brand name — hand those findings back to the
   * model for one revision pass before the answer is final.
   *
   * Detection without correction was the gap. Ten measured sessions produced
   * answers whose invented parts were identified accurately and then shown to
   * the user underneath the answer they had already read. This spends one more
   * round to fix what was found, and only on answers already known to contain
   * unsupported specifics — a clean turn never pays for it.
   */
  autoCorrect: boolean
  /**
   * v1.5: inject a short per-domain method ("playbook") into the turn for
   * first-aid, health, finance, legal, home, data, code, comparison and
   * planning questions. Disclosed under the reply. On by default: it costs a
   * few dozen tokens and is the cheapest lift a small model gets.
   */
  playbooks: boolean
  /**
   * v1.5.1: when "think harder" runs with only one slot enabled, let the
   * answerer review its own draft (labelled as such) rather than doing
   * nothing. On by default: the structure of a review pass catches arithmetic
   * slips and skipped steps even from the same model; the disclosure keeps it
   * honest. Off = think-harder requires a second slot, like second opinions.
   */
  selfReview: boolean
  /**
   * v1.6: Workbench verification — recompute a reply's stated figures in
   * Python when nothing computed them, and run the Python a reply contains.
   * Findings go through the same one-revision gate as other grounding.
   */
  workbenchChecks: boolean
  /**
   * v1.9: the conversation ledger — a mechanical record of computed facts,
   * attached files, session state and the user's stated constraints, built
   * from tool results and the user's own words (never earlier replies) and
   * handed to the model as turn notes once a conversation is long enough for
   * a small model to have lost the thread. Disclosed under the reply.
   */
  ledger: boolean
}

export interface ClaimCheckSettings {
  /**
   * v1.2: mechanical per-claim verification of unverified answers. Requires
   * secondOpinion.enabled — the critic slot extracts and judges, never the
   * answerer.
   */
  enabled: boolean
  /** Cap on extracted claims checked per reply; keeps the pass cheap. */
  maxClaims: number
}

export interface AuditSettings {
  /** Append-only session transcript. Off by default — a privacy app does not log by default. */
  enabled: boolean
  /** Delete every audit log when the app quits. */
  autoPurgeOnQuit: boolean
}

export interface PlanSettings {
  /** Max steps a generated plan may contain (1–10). */
  maxSteps: number
  /** Show the plan for approval before executing. On by default. */
  confirmPlan: boolean
}

import { normalizeProjects, type Project } from './projects'
import { recallFromConversations, type StoredConversationLike } from './projectRecall'
import { indexAttachment, isAttachmentIndexed } from './attachmentIndex'
import { readTextDocument } from './attachments'
export type { Project, ProjectColor } from './projects'

export interface AppSettings {
  baseUrl: string
  models: ModelConfig[]
  theme: 'light' | 'dark'
  fontSize: number
  historyLimit: number
  tools: ToolToggles
  workingDirectory: string
  pipeline: string[] // ordered list of model config ids for collaborative mode
  voice: VoiceSettings
  stt: SttSettings
  memory: MemorySettings
  search: SearchSettings
  research: ResearchSettings
  proxy: ProxySettings
  updates: UpdateSettings
  /** First-run setup checklist has been dismissed. */
  onboardingCompleted: boolean
  /** Hide tool-call blocks in chat; show a thinking animation instead. */
  hideToolCalls: boolean
  /**
   * How the chain-of-thought block appears in chat: collapsed behind a
   * "Thought for Xs" header (default), always expanded, or hidden entirely.
   */
  reasoningDisplay: 'collapsed' | 'expanded' | 'hidden'
  /** Show tokens/sec and time-to-first-token under each reply. */
  showResponseStats: boolean
  /**
   * v1.9.2: the conversation rail is collapsed to an icon strip. Persisted
   * rather than per-session because a window someone deliberately made narrow
   * should still be narrow tomorrow.
   */
  sidebarCollapsed: boolean
  /** v1.10: the chat panel (right side) is collapsed to an icon strip (⌘J). */
  rightPanelCollapsed: boolean
  /** v1.10: conversation groups shown in the rail. */
  projects: Project[]
  /**
   * What happens when a conversation outgrows the model's context window.
   * 'compact' summarizes the dropped span and carries it forward; 'trim'
   * silently drops it, which is what every version before 0.8.2 did.
   */
  contextManagement: 'compact' | 'trim'
  /** v0.9: a second role reviews replies on request (Settings → Models). */
  secondOpinion: SecondOpinionSettings
  /** v1.2: mechanical per-claim verification of unverified answers. */
  claimCheck: ClaimCheckSettings
  /** v1.4.6: revise an answer whose specifics the tools did not support. */
  grounding: GroundingSettings
  /** v1.4: private shopping research. Tools ship off; this governs how they behave. */
  shopping: ShoppingSettings
  /** v0.9: append-only encrypted session transcript (Settings → Privacy). */
  audit: AuditSettings
  /** v0.9: multi-step plan generation and execution. */
  plan: PlanSettings
}

/**
 * Default sampling for a new slot. All four built-in roles default to 0.3:
 * pure recall at 0.7 measurably increases confabulation on small local
 * models (v1.1 grounding), and Coder/Finance Coach do factual work too
 * (v1.2). Creative use is a preset click away. Saved per-slot values are
 * never rewritten — normalizeSampling preserves them.
 */
export function defaultSampling(temperature = 0.7): SamplingSettings {
  return { temperature, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 }
}

// Exported for the orchestrate eval, which builds its specialist roster from
// the app's own template personas rather than restating them.
export function defaultSettings(): AppSettings {
  return {
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: [
      {
        id: 'model-1',
        modelId: 'google/gemma-4-12b-qat',
        roleName: 'Assistant',
        systemPrompt:
          'You are a helpful, harmless, and honest AI assistant. Answer questions clearly and concisely, ' +
          'leading with the answer. Treat a short follow-up ("and the price?", "what about the first one?") ' +
          'as part of the ongoing conversation, never as a brand-new question. Do not assume the user\u2019s ' +
          'gender, age, body, or life situation — when it would change the recommendation, ask first. ' +
          'The chat UI renders Markdown but not LaTeX math notation, so write formulas, units, and ' +
          'symbols as plain text (for example, 374 °C or E = mc^2) instead of $...$ markup.',
        color: 'blue',
        enabled: true,
        sampling: defaultSampling(0.3),
        contextWindow: null
      },
      {
        id: 'model-2',
        modelId: '',
        roleName: 'Researcher',
        systemPrompt:
          'You are a meticulous researcher. Use available tools to gather facts, cite sources, and summarize findings.',
        color: 'purple',
        enabled: false,
        sampling: defaultSampling(0.3),
        contextWindow: null,
        specialty: 'research',
      },
      {
        id: 'model-3',
        modelId: '',
        roleName: 'Coder',
        systemPrompt:
          'You are an expert software engineer. Write clean, correct code and explain your reasoning briefly.',
        color: 'green',
        enabled: false,
        sampling: defaultSampling(0.3),
        contextWindow: null,
        specialty: 'coding',
      },
      {
        id: 'model-4',
        modelId: '',
        roleName: 'Finance Coach',
        systemPrompt:
          'You are a patient financial literacy coach. Teach concepts clearly with everyday ' +
          'examples, and build understanding rather than lecturing about risk. For any numbers, ' +
          'such as loan payments, compound growth, savings goals, or inflation, always use the ' +
          'finance_calculator tool instead of mental arithmetic, and state the assumptions you ' +
          'used. For current rates, prices, or market figures, use web_search rather than ' +
          'guessing. Help users evaluate options themselves: compare scenarios factually, ' +
          'explain tradeoffs, and never tell them what to buy or sell. End finance answers with ' +
          'one short line noting this is education, not personalized financial advice.',
        color: 'green',
        enabled: false,
        sampling: defaultSampling(0.3),
        contextWindow: null,
        specialty: 'finance',
      },
      {
        id: 'model-5',
        modelId: '',
        roleName: 'Data Analyst',
        // v1.6: the persona exists so the *routing* has a destination — the
        // method itself is the data playbook, which fires on any data turn
        // whichever slot answers. What this adds is the ability to send a
        // spreadsheet question to a different (usually larger) model, and a
        // prompt that names the two tools that make the answer exact.
        systemPrompt:
          'You are a careful data analyst. Never estimate a number you could compute. Attached data ' +
          'files are available to you at /work/<name>: start from analyze_file for a file you have ' +
          'not profiled yet, then compute with run_python (pandas and numpy are available offline). ' +
          'run_python keeps its variables between calls in a conversation: for a follow-up question, ' +
          'work from the dataframe already loaded rather than reading the file again. ' +
          'Report every figure with its unit and denominator, say how many rows it covers, and name ' +
          'the rows you had to exclude — a mean over 380 of 400 rows is a different number and the ' +
          'user needs to know which they have. Never aggregate a price, rate or percentage column ' +
          'with sum() — summing unit prices produces a number with no meaning; weight it by quantity ' +
          'or take the mean, and label which you did. Keep measurement and interpretation apart: give the ' +
          'numbers first, then what you think they mean, labelled as such. Charts are welcome — save ' +
          'a matplotlib figure as a .png and it appears in the chat.',
        color: 'purple',
        enabled: false,
        sampling: defaultSampling(0.3),
        specialty: 'data',
        contextWindow: null
      }
    ],
    // Light is the flagship look since 1.0; existing installs keep their saved choice.
    theme: 'light',
    fontSize: 15,
    historyLimit: 100,
    tools: {
      read_file: true,
      // Off by default: these two mutate the machine. Opt in under Settings → Tools.
      write_file: false,
      list_directory: true,
      run_terminal_command: false,
      web_search: true,
      image_search: true,
      fetch_webpage: true,
      date_calculator: true,
      geo_locate: true,
      get_current_datetime: true,
      create_note: true,
      list_notes: true,
      read_note: true,
      memory_save: true,
      memory_search: true,
      memory_forget: true,
      // v1.5: on by default — it reads only the user's own installed packs and
      // never touches the network, so there is nothing to consent to.
      reference_lookup: true,
      // v1.6: on by default — sandboxed by construction, touches nothing outside the app.
      run_python: true,
      analyze_file: true,
      deep_research: true,
      finance_calculator: true,
      // Off by default: these initiate outbound requests to commercial sites
      // that log them. That should be a choice the user makes on purpose.
      shop_requirements: false,
      shop_compare: false,
      price_watch: false,
      // v1.12: off by default — a ticker lookup discloses what you are researching.
      market_data: false
    },
    workingDirectory: '',
    pipeline: ['model-1'],
    voice: {
      autoRead: false,
      voiceURI: '',
      rate: 1
    },
    stt: {
      whisperCliPath: '',
      whisperModelPath: ''
    },
    memory: {
      autoContext: true,
      topK: 3,
      embeddingModel: ''
    },
    search: {
      provider: 'duckduckgo',
      searxngUrl: 'http://127.0.0.1:8888',
      maxResults: 8,
      confirmBeforeSearch: false,
      useHeadlessRenderer: false
    },
    research: {
      depth: 'standard',
      confirmPlan: false
    },
    proxy: {
      mode: 'none',
      // Tor's default SOCKS port; the Tor Browser bundle uses 9150.
      host: '127.0.0.1',
      port: 9050
    },
    updates: {
      autoCheck: false
    },
    onboardingCompleted: false,
    hideToolCalls: false,
    reasoningDisplay: 'collapsed',
    showResponseStats: true,
    sidebarCollapsed: false,
    rightPanelCollapsed: false,
    projects: [],
    contextManagement: 'compact',
    secondOpinion: {
      enabled: false,
      criticSlotId: null
    },
    grounding: { autoCorrect: true, playbooks: true, selfReview: true, workbenchChecks: true, ledger: true },
    claimCheck: {
      // On by default, but only fires when second opinions are also enabled —
      // the critic slot does the extraction and judging.
      enabled: true,
      maxClaims: 5
    },
    shopping: {
      requireProxy: true,
      maxSellers: 4,
      excludeTierX: true
    },
    audit: {
      enabled: false,
      autoPurgeOnQuit: false
    },
    plan: {
      maxSteps: 6,
      confirmPlan: true
    }
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * The LM Studio base URL must be a loopback address.
 *
 * Why (v1.4.8). LM Studio traffic carries every conversation in plaintext, so
 * it deliberately bypasses the proxy (net.ts) and is described everywhere as
 * "loopback". Before this check a hand-edited or mistyped remote base URL
 * silently sent embeddings, planning and research prompts off-machine on that
 * un-proxied path — the worst of both worlds. The renderer's CSP already
 * refuses non-loopback chat, so a remote value never worked as a whole; it only
 * leaked. Anything not loopback reverts to the default and the Settings UI says
 * so. If remote LM Studio is ever wanted it must be an explicit opt-in that
 * also routes through the egress path — not a value that happens to parse.
 */
function normalizeBaseUrl(value: unknown, fallback: string): string {
  const candidate = str(value, fallback).trim()
  return isLoopbackBaseUrl(candidate) ? candidate : fallback
}

/** Like clamp, but without rounding — sampling values are fractional. */
function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Sampling needs its own merge rather than riding the `{ ...base, ...m }`
 * spread the model loop uses: a spread copies a half-written or hand-edited
 * `sampling` object through verbatim, and a NaN temperature reaching the wire
 * makes LM Studio reject every request in the conversation.
 */
function normalizeSampling(value: unknown): SamplingSettings {
  const s = (value ?? {}) as Partial<SamplingSettings>
  const defaults = defaultSampling()
  const seed = typeof s.seed === 'number' && Number.isFinite(s.seed) ? Math.round(s.seed) : null
  return {
    temperature: clampFloat(s.temperature, 0, 2, defaults.temperature),
    topP: clampFloat(s.topP, 0.01, 1, defaults.topP),
    // -1 means "server default". A cleared number input reads as 0/NaN, and
    // clamping that up to 1 would silently cap every reply at one token — so
    // anything non-positive falls back to the server default instead.
    maxTokens: Number(s.maxTokens) > 0 ? clamp(s.maxTokens, 1, 128_000, -1) : -1,
    seed,
    // Negative is a real setting here ("auto"), not a fallback, so an absent
    // or unparseable value has to land on it rather than on zero — zero means
    // the user explicitly turned the sampler off.
    topK: Number.isFinite(Number(s.topK)) ? clamp(s.topK, -1, 500, -1) : -1,
    minP: Number.isFinite(Number(s.minP)) ? clampFloat(s.minP, -1, 1, -1) : -1
  }
}

/**
 * Keeps malformed values out of persistence, whether they come from the
 * settings UI or a hand-edited / corrupted config.json. A historyLimit of 0 —
 * which a cleared number input produces — would otherwise make the renderer
 * prune every saved conversation from disk on the next load.
 */
/** Specialty for the canonical template role names (see the backfill note above). */
function backfillSpecialty(roleName: unknown): ModelConfig['specialty'] {
  switch (typeof roleName === 'string' ? roleName.trim().toLowerCase() : '') {
    case 'researcher':
      return 'research'
    case 'coder':
      return 'coding'
    case 'finance coach':
      return 'finance'
    case 'data analyst':
      return 'data'
    default:
      return undefined
  }
}

export function normalizeSettings(settings: AppSettings): AppSettings {
  const defaults = defaultSettings()
  const rate = Number(settings.voice?.rate)

  const models = Array.isArray(settings.models) && settings.models.length > 0
    ? settings.models.map((m, i) => {
        const base = defaults.models[i] ?? defaults.models[0]
        return {
          ...base,
          ...m,
          id: str(m?.id, base.id),
          modelId: str(m?.modelId, ''),
          roleName: str(m?.roleName, base.roleName),
          systemPrompt: str(m?.systemPrompt, base.systemPrompt),
          color: ['blue', 'purple', 'green'].includes(m?.color) ? m.color : base.color,
          enabled: Boolean(m?.enabled),
          sampling: normalizeSampling(m?.sampling),
          contextWindow:
            typeof m?.contextWindow === 'number' && m.contextWindow >= 512
              ? Math.round(m.contextWindow)
              : null,
          // Absent stays absent (= all globally-enabled tools); a stored array
          // is an allowlist, sanitized to plain strings.
          tools: Array.isArray(m?.tools)
            ? m.tools.filter((t): t is string => typeof t === 'string')
            : undefined,
          // Routing declarations (v1.4): a trimmed non-empty string, else absent.
          capability:
            typeof m?.capability === 'string' && m.capability.trim()
              ? m.capability.trim()
              : undefined,
          // v1.11.2: absent specialty on a canonical template role is backfilled.
          // Through v1.11.1 only the Data Analyst template carried a specialty,
          // so the pre-flight router could never route research, coding or
          // finance turns — three of the four specialties were structurally
          // unreachable unless the user found the field in Settings. A renamed
          // role stays untouched: the name is the signal that the slot is
          // still the template.
          specialty:
            m?.specialty === 'coding' ||
            m?.specialty === 'research' ||
            m?.specialty === 'finance' ||
            m?.specialty === 'data'
              ? m.specialty
              : backfillSpecialty(m?.roleName)
        }
      })
    : defaults.models

  const tools = { ...defaults.tools }
  for (const key of Object.keys(tools) as (keyof ToolToggles)[]) {
    if (settings.tools && key in settings.tools) tools[key] = Boolean(settings.tools[key])
  }

  // Built key by key from `defaults` rather than spread from the input: a
  // renderer (or a hand-edited config.json) cannot smuggle unknown keys into
  // what gets persisted, and a key added to AppSettings without a rule here is
  // a compile error rather than a value that rides through unchecked.
  const normalized: AppSettings = {
    baseUrl: normalizeBaseUrl(settings.baseUrl, defaults.baseUrl),
    models,
    theme: settings.theme === 'light' ? 'light' : 'dark',
    fontSize: clamp(settings.fontSize, 12, 20, 15),
    historyLimit: clamp(settings.historyLimit, 10, 1000, 100),
    tools,
    workingDirectory: str(settings.workingDirectory, ''),
    pipeline: Array.isArray(settings.pipeline)
      ? settings.pipeline.filter((id): id is string => typeof id === 'string')
      : defaults.pipeline,
    voice: {
      ...defaults.voice,
      ...settings.voice,
      autoRead: Boolean(settings.voice?.autoRead),
      voiceURI: str(settings.voice?.voiceURI, ''),
      rate: Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1
    },
    stt: {
      whisperCliPath: str(settings.stt?.whisperCliPath, ''),
      whisperModelPath: str(settings.stt?.whisperModelPath, '')
    },
    memory: {
      ...defaults.memory,
      ...settings.memory,
      autoContext: Boolean(settings.memory?.autoContext),
      embeddingModel: str(settings.memory?.embeddingModel, ''),
      topK: clamp(settings.memory?.topK, 1, 8, 3)
    },
    search: {
      provider: (['searxng', 'brave', 'duckduckgo'] as const).includes(
        settings.search?.provider as SearchProviderId
      )
        ? (settings.search!.provider as SearchProviderId)
        : defaults.search.provider,
      searxngUrl: str(settings.search?.searxngUrl, defaults.search.searxngUrl),
      maxResults: clamp(settings.search?.maxResults, 1, 10, defaults.search.maxResults),
      confirmBeforeSearch: Boolean(settings.search?.confirmBeforeSearch),
      useHeadlessRenderer: Boolean(settings.search?.useHeadlessRenderer)
    },
    research: {
      depth: (['quick', 'standard', 'thorough'] as const).includes(
        settings.research?.depth as ResearchSettings['depth']
      )
        ? settings.research!.depth
        : defaults.research.depth,
      confirmPlan: Boolean(settings.research?.confirmPlan)
    },
    proxy: {
      mode: (['none', 'socks5', 'http'] as const).includes(
        settings.proxy?.mode as ProxySettings['mode']
      )
        ? settings.proxy!.mode
        : defaults.proxy.mode,
      host: str(settings.proxy?.host, defaults.proxy.host),
      port: clamp(settings.proxy?.port, 1, 65535, defaults.proxy.port)
    },
    updates: {
      autoCheck: Boolean(settings.updates?.autoCheck)
    },
    onboardingCompleted: Boolean(settings.onboardingCompleted),
    hideToolCalls: Boolean(settings.hideToolCalls),
    reasoningDisplay: (['collapsed', 'expanded', 'hidden'] as const).includes(
      settings.reasoningDisplay as AppSettings['reasoningDisplay']
    )
      ? (settings.reasoningDisplay as AppSettings['reasoningDisplay'])
      : 'collapsed',
    showResponseStats: settings.showResponseStats !== false,
    sidebarCollapsed: Boolean(settings.sidebarCollapsed),
    rightPanelCollapsed: Boolean(settings.rightPanelCollapsed),
    projects: normalizeProjects(settings.projects),
    contextManagement: settings.contextManagement === 'trim' ? 'trim' : 'compact',
    secondOpinion: {
      enabled: Boolean(settings.secondOpinion?.enabled),
      criticSlotId:
        typeof settings.secondOpinion?.criticSlotId === 'string' &&
        models.some((m) => m.id === settings.secondOpinion?.criticSlotId)
          ? settings.secondOpinion.criticSlotId
          : null
    },
    claimCheck: {
      enabled: settings.claimCheck?.enabled !== false,
      maxClaims: clamp(settings.claimCheck?.maxClaims, 1, 10, defaults.claimCheck.maxClaims)
    },
    grounding: {
      autoCorrect: settings.grounding?.autoCorrect !== false,
      playbooks: settings.grounding?.playbooks !== false,
      selfReview: settings.grounding?.selfReview !== false,
      workbenchChecks: settings.grounding?.workbenchChecks !== false,
      ledger: settings.grounding?.ledger !== false
    },
    shopping: {
      // Defaults to on: an absent or malformed value must not silently disable
      // the proxy requirement, which is the setting most costly to get wrong.
      requireProxy: settings.shopping?.requireProxy !== false,
      maxSellers: clamp(settings.shopping?.maxSellers, 1, 5, defaults.shopping.maxSellers),
      excludeTierX: settings.shopping?.excludeTierX !== false
    },
    audit: {
      enabled: Boolean(settings.audit?.enabled),
      autoPurgeOnQuit: Boolean(settings.audit?.autoPurgeOnQuit)
    },
    plan: {
      maxSteps: clamp(settings.plan?.maxSteps, 1, 10, defaults.plan.maxSteps),
      confirmPlan: settings.plan?.confirmPlan !== false
    }
  }
  return normalized
}

/**
 * Fills in settings keys added after the user's config was first written
 * (e.g. voice/stt landed in v0.3). Runs once at startup.
 */
export function migrateSettings(): void {
  const current = readSettings() as Partial<AppSettings>
  const defaults = defaultSettings()
  const merged: AppSettings = {
    ...defaults,
    ...current,
    tools: { ...defaults.tools, ...current.tools },
    voice: { ...defaults.voice, ...current.voice },
    stt: { ...defaults.stt, ...current.stt },
    memory: { ...defaults.memory, ...current.memory },
    search: { ...defaults.search, ...current.search },
    research: { ...defaults.research, ...current.research },
    proxy: { ...defaults.proxy, ...current.proxy },
    updates: { ...defaults.updates, ...current.updates },
    secondOpinion: { ...defaults.secondOpinion, ...current.secondOpinion },
    claimCheck: { ...defaults.claimCheck, ...current.claimCheck },
    grounding: { ...defaults.grounding, ...current.grounding },
    shopping: { ...defaults.shopping, ...current.shopping },
    audit: { ...defaults.audit, ...current.audit },
    plan: { ...defaults.plan, ...current.plan }
  } as AppSettings
  writeSettings(normalizeSettings(merged))
}

/**
 * Rebrand migration (FunkinAI → Sigma Oasis): the app data directory is named
 * after the app, so renaming the app would orphan every setting, conversation,
 * note and memory. Chromium creates the new profile directory at startup —
 * before this module runs — so migration is per-item: legacy data wins over
 * the just-created fresh defaults (those are kept as *.pre-rebrand-backup).
 * Runs at import time, before `new Store` below.
 */
function migrateLegacyDataDir(): void {
  try {
    const current = app.getPath('userData')
    const marker = join(current, '.rebrand-migrated')
    if (existsSync(marker)) return
    const appData = app.getPath('appData')
    // 'FunkinAI' = packaged builds (productName), 'funkinai' = dev (npm name).
    // Prefer the dir matching this run mode when both exist.
    const packaged = join(appData, 'FunkinAI')
    const dev = join(appData, 'funkinai')
    const candidates = app.isPackaged ? [packaged, dev] : [dev, packaged]
    for (const legacy of candidates) {
      if (legacy === current || !existsSync(legacy)) continue
      for (const item of ['config.json', 'conversations', 'notes.json', 'memory.json']) {
        const src = join(legacy, item)
        const dst = join(current, item)
        if (!existsSync(src)) continue
        if (existsSync(dst) && !existsSync(`${dst}.pre-rebrand-backup`)) {
          renameSync(dst, `${dst}.pre-rebrand-backup`)
        }
        if (!existsSync(dst)) renameSync(src, dst)
      }
      writeFileSync(marker, new Date().toISOString())
      return
    }
    // No legacy data found — nothing to migrate; re-check next launch.
  } catch {
    // Best effort — a fresh directory is created either way.
  }
}
migrateLegacyDataDir()

interface StoredSecrets {
  /** Brave Search API key, safeStorage-encrypted (base64) when the OS keychain is available. */
  braveApiKey?: string
  /** True when braveApiKey could only be stored unencrypted (no OS keychain). */
  braveApiKeyUnencrypted?: boolean
}

const store = new Store<{ settings: AppSettings; secrets?: StoredSecrets }>({
  defaults: { settings: defaultSettings() }
})

/**
 * Settings cache. electron-store's `conf` re-reads and re-parses config.json
 * on *every* `store.get` — a synchronous disk read on hot paths (per fetch via
 * proxyActive(), per completion, per audit entry). All reads and writes of the
 * `settings` key must go through readSettings/writeSettings so the cache can
 * never go stale. The cached object is deep-frozen: it is shared across 35
 * call sites, so an accidental mutation must throw rather than silently leak
 * into every other consumer. External edits to config.json while the app runs
 * are no longer observed — that was never supported behavior.
 */
let settingsCache: AppSettings | null = null

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj)) deepFreeze(value)
    Object.freeze(obj)
  }
  return obj
}

function readSettings(): AppSettings {
  if (!settingsCache) settingsCache = deepFreeze(store.get('settings'))
  return settingsCache
}

/** Exported for the eval harness, which runs against an isolated userData and must point search at its fixture server. */
export function writeSettings(settings: AppSettings): void {
  store.set('settings', settings)
  // Re-read rather than trusting the argument: conf's own serialization is
  // the source of truth for what a later cold start will see.
  settingsCache = deepFreeze(store.get('settings'))
}

/**
 * API keys never live in `settings` (which round-trips to the renderer in
 * plaintext). They go through safeStorage into a separate store key; the
 * renderer only ever learns whether a key is set.
 */
export function setBraveApiKey(key: string): { ok: boolean; warning?: string } {
  const trimmed = key.trim()
  if (!trimmed) {
    store.set('secrets', {})
    return { ok: true }
  }
  if (safeStorage.isEncryptionAvailable()) {
    store.set('secrets', { braveApiKey: safeStorage.encryptString(trimmed).toString('base64') })
    return { ok: true }
  }
  // No OS keychain (some Linux setups). Store it, but tell the user.
  store.set('secrets', { braveApiKey: trimmed, braveApiKeyUnencrypted: true })
  return {
    ok: true,
    warning:
      'OS keychain unavailable — the API key was stored without encryption in config.json.'
  }
}

export function getBraveApiKey(): string | null {
  const secrets = store.get('secrets')
  if (!secrets?.braveApiKey) return null
  if (secrets.braveApiKeyUnencrypted) return secrets.braveApiKey
  try {
    return safeStorage.decryptString(Buffer.from(secrets.braveApiKey, 'base64'))
  } catch {
    return null
  }
}

export function braveApiKeyStatus(): { set: boolean; encrypted: boolean } {
  const secrets = store.get('secrets')
  return {
    set: Boolean(secrets?.braveApiKey),
    encrypted: Boolean(secrets?.braveApiKey && !secrets.braveApiKeyUnencrypted)
  }
}

// ---- Conversation & note file persistence ----------------------------------

function conversationsDir(): string {
  return join(app.getPath('userData'), 'conversations')
}

function notesFile(): string {
  return join(app.getPath('userData'), 'notes.json')
}

/**
 * Conversation ids become filenames, so they must not contain separators or
 * `..` — otherwise a save/delete could reach outside the conversations dir.
 */
function conversationFile(id: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(id) ? join(conversationsDir(), `${id}.json`) : null
}

/** Read one stored conversation, or null when it is not on disk (deleted, ephemeral, bad id). */
export async function readStoredConversation(id: string): Promise<StoredConversationLike | null> {
  const file = conversationFile(id)
  if (!file) return null
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as StoredConversationLike & { ephemeral?: boolean }
    if (!parsed || parsed.ephemeral || !Array.isArray(parsed.messages)) return null
    return parsed
  } catch {
    return null
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export interface Note {
  title: string
  content: string
  createdAt: number
}

export async function readNotes(): Promise<Note[]> {
  try {
    const raw = await fs.readFile(notesFile(), 'utf-8')
    return JSON.parse(raw) as Note[]
  } catch {
    return []
  }
}

export async function writeNotes(notes: Note[]): Promise<void> {
  await writeFileAtomic(notesFile(), JSON.stringify(notes, null, 2))
}

/**
 * Registers all IPC handlers related to persistence: settings, conversations.
 */
export function registerStoreHandlers(): void {
  // Reads and writes give the same guarantee: what the renderer receives is
  // exactly what a write of it would persist (v1.4.8 — before, reads shallow-
  // merged defaults while writes deep-normalized, so a stale install could see
  // half-filled nested settings until its first save).
  ipcMain.handle('store:getSettings', () =>
    normalizeSettings({ ...defaultSettings(), ...readSettings() })
  )

  ipcMain.handle('store:setSettings', (_e, settings: AppSettings) => {
    writeSettings(normalizeSettings(settings))
    return true
  })

  ipcMain.handle('store:resetSettings', () => {
    writeSettings(defaultSettings())
    return readSettings()
  })

  // Conversations are stored as one JSON file per conversation.
  ipcMain.handle('conversations:list', async () => {
    const dir = conversationsDir()
    await ensureDir(dir)
    const files = await fs.readdir(dir)
    const convos: unknown[] = []
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(join(dir, f), 'utf-8')
        convos.push(JSON.parse(raw))
      } catch {
        // ignore corrupt file
      }
    }
    // An ephemeral conversation must never come back from disk. If one somehow
    // landed there (a pre-guard build, a hand-copied file), it is dropped from
    // the list rather than resurrected as a normal conversation.
    return convos.filter((c) => !(c as { ephemeral?: boolean })?.ephemeral)
  })

  ipcMain.handle('conversations:save', async (_e, convo: { id: string; ephemeral?: boolean }) => {
    // Structural no-trace guarantee: an ephemeral conversation is never
    // written, regardless of what the renderer asks. This is the boundary
    // that must hold even if the renderer regresses.
    if (convo?.ephemeral) return false
    const file = conversationFile(String(convo?.id ?? ''))
    if (!file) return false
    await ensureDir(conversationsDir())
    await writeFileAtomic(file, JSON.stringify(convo, null, 2))
    return true
  })

  ipcMain.handle('conversations:delete', async (_e, id: string) => {
    const file = conversationFile(String(id ?? ''))
    if (!file) return false
    try {
      await fs.unlink(file)
    } catch {
      // already gone
    }
    return true
  })

  // v1.10 project-wide recall: the renderer names sibling chats by id; the
  // transcripts never cross the IPC boundary.
  ipcMain.handle(
    'projects:recall',
    (_e, ids: string[], query: string, topK: number) =>
      recallFromConversations(
        readStoredConversation,
        Array.isArray(ids) ? ids.map(String) : [],
        String(query ?? ''),
        Math.max(1, Math.min(12, Number(topK) || 4))
      )
  )

  // v1.10 project files: a path picker that reads nothing — the project keeps
  // paths only, and each chat indexes the file when it first needs it.
  ipcMain.handle('projects:pickFiles', async (event) => {
    const win = hostWindow(event.sender)
    if (!win) return []
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Pin files to this project',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Text & PDF', extensions: ['pdf', 'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'docx', 'ts', 'tsx', 'js', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'yaml', 'yml', 'toml', 'xml'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (canceled) return []
    return filePaths.map((p) => ({ name: p.split(/[\\/]/).pop() || p, sourcePath: p }))
  })

  // v1.10 pinned-file status: exists on disk? indexed this session? size. Cheap
  // stats only — nothing is read here.
  ipcMain.handle('projects:fileStatus', async (_e, files: { id: string; sourcePath: string }[]) => {
    const out: Record<string, { exists: boolean; indexed: boolean; sizeBytes: number | null }> = {}
    for (const f of Array.isArray(files) ? files : []) {
      const id = String(f?.id ?? '')
      const sourcePath = String(f?.sourcePath ?? '')
      let exists = false
      let sizeBytes: number | null = null
      try {
        const st = await fs.stat(sourcePath)
        exists = st.isFile()
        sizeBytes = st.size
      } catch {
        exists = false
      }
      out[id] = { exists, indexed: isAttachmentIndexed(`project-file-${id}`), sizeBytes }
    }
    return out
  })

  // v1.10: (re)index one pinned file now, rather than on first use — the
  // same read + index path the per-turn retrieval takes. The id prefix
  // matches projectFileRefs in the renderer.
  ipcMain.handle('projects:reindexFile', async (_e, file: { id: string; name: string; sourcePath: string }) => {
    const id = String(file?.id ?? '')
    const sourcePath = String(file?.sourcePath ?? '')
    if (!id || !sourcePath) return { ok: false, error: 'No file given.' }
    try {
      const doc = await readTextDocument(sourcePath, 8_000_000)
      const { chunks } = indexAttachment({
        id: `project-file-${id}`,
        name: String(file?.name ?? doc.name),
        text: doc.text,
        kind: sourcePath.toLowerCase().endsWith('.pdf') ? 'pdf' : 'text'
      })
      return { ok: true, chunks, chars: doc.text.length, truncated: doc.truncated }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Export a rendered Markdown transcript via the native save dialog.
  ipcMain.handle(
    'conversations:exportMarkdown',
    async (event, payload: { title: string; markdown: string }) => {
      const win = hostWindow(event.sender)
      if (!win) return { ok: false, canceled: true }
      const safeName =
        String(payload.title ?? 'conversation')
          .replace(/[^\w\s-]+/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .slice(0, 60) || 'conversation'
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Export conversation as Markdown',
        defaultPath: join(app.getPath('documents'), `${safeName}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      try {
        await fs.writeFile(filePath, String(payload.markdown ?? ''), 'utf-8')
        return { ok: true, path: filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

export function getSettings(): AppSettings {
  return readSettings()
}
