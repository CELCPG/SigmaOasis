/**
 * Capture README screenshots of the real renderer with staged data.
 *
 * Runs the production renderer build (out/renderer/index.html) inside the
 * project's own Electron, with every IPC channel stubbed to return fixture
 * data — no LM Studio, no disk state, deterministic output. One run per scene.
 *
 * Output: docs/screenshots/<scene>.png at the display's native scale. Run all:
 *
 *   ELECTRON="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
 *   for scene in welcome-light chat-light chat-dark vibe vibe-empty agent-light agent-dark settings-tools-dark settings-models-light; do
 *     SCENE=$scene "$ELECTRON" scripts/capture-screenshots.js
 *   done
 *
 * (On Linux the binary is node_modules/electron/dist/electron; needs a display
 * or xvfb-run.) The chat scenes are captured bottom-anchored like a real
 * viewport; trim the top ~172px so the crop starts at a block boundary.
 *
 * Data shapes mirror src/renderer/src/types.ts; keep the fixtures in sync when
 * the UI changes and re-run before releases that touch the interface.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const SCENE = process.env.SCENE || 'welcome-light'
const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots')

const THEME = SCENE.endsWith('-dark') ? 'dark' : 'light'
// v3.0: the VIBE scenes open the app in VIBE mode (the lagoon is always night).
const VIBE = SCENE.startsWith('vibe')
// v3.0: the agent scenes show a finished agent turn — its timeline, checklist and Undo.
const AGENT = SCENE.startsWith('agent')
// v4.0: `settings-<tab>-<theme>` opens Settings on that tab (a key from
// src/renderer/src/components/settings/tabs.ts: connection, models, general,
// grounding, memory, tools, agent, search, voice, library, skills, mcp, jobs,
// privacy, activity) over the chat scene.
const SETTINGS_TAB = SCENE.startsWith('settings-') ? SCENE.replace(/^settings-/, '').replace(/-(dark|light)$/, '') : null
const NOW = Date.now()
const MIN = 60_000

// ---------------------------------------------------------------- fixtures

const sampling = { temperature: 0.7, topP: 1, maxTokens: -1, seed: null }

const MODEL_SLOTS = [
  {
    id: 'model-1',
    modelId: 'qwen3-32b',
    roleName: 'Assistant',
    systemPrompt: 'You are Assistant, a helpful generalist.',
    color: 'blue',
    enabled: true,
    sampling,
    contextWindow: null
  },
  {
    id: 'model-2',
    modelId: 'qwen2.5-coder-14b-instruct',
    roleName: 'Coder',
    systemPrompt: 'You are Coder, a careful pair programmer.',
    color: 'purple',
    enabled: true,
    sampling,
    contextWindow: null
  },
  {
    id: 'model-3',
    modelId: 'gemma-3-12b-it',
    roleName: 'Finance Coach',
    systemPrompt: 'You are Finance Coach, a patient financial educator.',
    color: 'green',
    enabled: true,
    sampling,
    contextWindow: null
  }
]

function settings() {
  return {
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: MODEL_SLOTS,
    theme: THEME,
    fontSize: 15,
    historyLimit: 100,
    tools: {
      read_file: true,
      write_file: false,
      list_directory: true,
      run_terminal_command: false,
      web_search: true,
      fetch_webpage: true,
      get_current_datetime: true,
      create_note: true,
      list_notes: true,
      read_note: true,
      memory_save: true,
      memory_search: true,
      memory_forget: true,
      deep_research: true,
      finance_calculator: true
    },
    workingDirectory: '',
    pipeline: ['model-1', 'model-2'],
    voice: { autoRead: false, voiceURI: '', rate: 1 },
    stt: { whisperCliPath: '', whisperModelPath: '' },
    memory: { autoContext: true, topK: 4, embeddingModel: '' },
    search: {
      provider: 'duckduckgo',
      searxngUrl: '',
      maxResults: 5,
      confirmBeforeSearch: false,
      useHeadlessRenderer: false
    },
    research: { depth: 'standard', confirmPlan: true },
    proxy: { mode: 'none', host: '', port: 0 },
    updates: { autoCheck: true },
    onboardingCompleted: true,
    vibeMode: VIBE,
    hideToolCalls: false,
    reasoningDisplay: 'collapsed',
    showResponseStats: true,
    // Settings the fixture predated (v1.10 → v2.7). Without them the renderer
    // throws on its first `settings.projects.find`, and every scene captured
    // the error screen instead of the app.
    sidebarCollapsed: false,
    rightPanelCollapsed: false,
    projects: [],
    contextManagement: 'compact',
    secondOpinion: { enabled: true, criticSlotId: null },
    grounding: { autoCorrect: true, playbooks: true, selfReview: true, workbenchChecks: true, ledger: true, factLedger: true, outline: false },
    claimCheck: { enabled: true, maxClaims: 5 },
    shopping: { requireProxy: true, maxSellers: 4, excludeTierX: true },
    audit: { enabled: false, autoPurgeOnQuit: false },
    mcp: { servers: [] },
    plan: { maxSteps: 6, confirmPlan: true },
    agent: { maxRounds: 40, commandTimeoutSec: 120, defaultPermission: 'ask', appTools: true, notify: true }
  }
}

const CATALOG = {
  detailed: true,
  models: [
    {
      id: 'qwen3-32b',
      type: 'llm',
      vision: false,
      loaded: true,
      loadedContextLength: 32768,
      maxContextLength: 131072,
      quantization: 'Q4_K_M',
      arch: 'qwen3'
    },
    {
      id: 'qwen2.5-coder-14b-instruct',
      type: 'llm',
      vision: false,
      loaded: true,
      loadedContextLength: 32768,
      maxContextLength: 32768,
      quantization: 'Q5_K_M',
      arch: 'qwen2'
    },
    {
      id: 'gemma-3-12b-it',
      type: 'vlm',
      vision: true,
      loaded: true,
      loadedContextLength: 16384,
      maxContextLength: 131072,
      quantization: 'Q4_K_M',
      arch: 'gemma3'
    },
    { id: 'text-embedding-nomic-embed-text-v1.5', type: 'embeddings', loaded: true }
  ]
}

/** The showcase thread: memory recall + reasoning + a tool call + second opinion + a running plan. */
function financeConversation() {
  return {
    id: 'convo-demo',
    title: 'Crushing the card balance',
    mode: 'independent',
    activeModelSlotId: 'model-1',
    createdAt: NOW - 62 * MIN,
    updatedAt: NOW - 3 * MIN,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content:
          "I'm carrying $4,800 on a card at 24.9% APR and can put $350 a month toward it. Is it worth being more aggressive? Show me the actual math.",
        createdAt: NOW - 58 * MIN
      },
      {
        id: 'm2',
        role: 'assistant',
        roleName: 'Assistant',
        modelId: 'qwen3-32b',
        color: 'blue',
        reasoning:
          'The user wants a concrete payoff comparison, not generic advice. Their budget note says ~$620/month is discretionary, so a $450 scenario is realistic. Run the amortization through finance_calculator rather than estimating — mental APR math drifts.',
        reasoningMs: 12000,
        toolCalls: [
          {
            id: 'tc1',
            name: 'finance_calculator',
            args: { principal: 4800, apr: 0.249, monthly_payment: [350, 450, 500] },
            result:
              '$350/mo → 16 months, $873 interest · $450/mo → 12 months, $674 interest · $500/mo → 11 months, $586 interest',
            status: 'done'
          }
        ],
        content: `Yes — and the math makes the case clearly. Here's what the balance costs at three payment levels, assuming no new charges:

| Monthly payment | Payoff time | Total interest |
| --- | --- | --- |
| $350 | 16 months | $873 |
| **$450** | **12 months** | **$674** |
| $500 | 11 months | $586 |

A few things worth noticing:

- Going from $350 to **$450** saves **$199** and frees you four months sooner — the best return per extra dollar here.
- After $450 the curve flattens: another $50 only buys one month and $88.
- Your June statement shows two subscriptions you flagged as unused; cancelling them covers most of the jump to $450 on its own.

Education, not personalized financial advice.`,
        memoryContext: [
          {
            source: 'household-budget-2026.md',
            score: 0.84,
            text: 'Monthly discretionary after essentials: ~$620. Wants to build a $1,000 emergency fund before investing.'
          },
          {
            source: 'card-statement-june.pdf',
            score: 0.79,
            text: 'Statement balance $4,812.40 · APR 24.9% · minimum payment $96 · two recurring charges flagged by the user in May.'
          }
        ],
        secondOpinion: {
          roleName: 'Finance Coach',
          modelId: 'gemma-3-12b-it',
          text: 'Could not verify the 24.9% APR against the actual statement from this conversation alone — settle it by checking the APR line on the June statement. The interest figures also assume no new charges; that assumption is worth confirming.',
          createdAt: NOW - 55 * MIN
        },
        stats: {
          promptTokens: 2134,
          completionTokens: 486,
          tokensPerSecond: 38.2,
          ttftMs: 640,
          totalMs: 13360
        },
        createdAt: NOW - 56 * MIN
      },
      {
        id: 'm3',
        role: 'user',
        content: 'Perfect — turn the $450 scenario into a plan I can actually follow.',
        createdAt: NOW - 51 * MIN
      },
      {
        id: 'm4',
        role: 'assistant',
        roleName: 'Assistant',
        modelId: 'qwen3-32b',
        color: 'blue',
        content: 'Here it is — two steps are already done:',
        plan: {
          steps: [
            {
              id: 's1',
              title: 'Set up autopay at $450/month',
              detail: 'Fixed amount, not minimum — the minimum drops as the balance falls and quietly stretches the debt.',
              status: 'done',
              output: 'Autopay confirmation saved to notes.'
            },
            {
              id: 's2',
              title: 'Cancel the two flagged subscriptions',
              detail: 'The $18.99 and $12.99 recurring charges from the June statement — that is most of the jump from $350.',
              status: 'done',
              output: 'Both cancelled; effective next billing date.'
            },
            {
              id: 's3',
              title: 'Move $2,000 to the 0% balance-transfer offer',
              detail: 'The pre-approved offer in the June envelope: 0% for 15 months, 3% fee ($60 — still $140+ ahead).',
              status: 'running'
            },
            {
              id: 's4',
              title: 'Re-check the payoff date in 3 months',
              detail: 'If the transfer lands, the remaining $2,800 at 24.9% should be gone in ~7 months.',
              status: 'pending'
            }
          ],
          approved: true,
          createdAt: NOW - 50 * MIN
        },
        stats: {
          promptTokens: 3102,
          completionTokens: 212,
          tokensPerSecond: 41.6,
          ttftMs: 590,
          totalMs: 5690
        },
        createdAt: NOW - 49 * MIN
      }
    ]
  }
}

const SIDEBAR_CONVOS = [
  {
    id: 'convo-edo',
    title: 'Basic first aid training',
    mode: 'independent',
    activeModelSlotId: 'model-1',
    messages: [],
    createdAt: NOW - 26 * 60 * MIN,
    updatedAt: NOW - 25 * 60 * MIN
  },
  {
    id: 'convo-board',
    title: 'Fixing a leaky faucet, step by step',
    mode: 'orchestrated',
    activeModelSlotId: 'model-1',
    orchestratorSlotId: 'model-1',
    messages: [],
    memorySources: ['company-handbook.pdf'],
    createdAt: NOW - 49 * 60 * MIN,
    updatedAt: NOW - 48 * 60 * MIN
  },
  {
    id: 'convo-hike',
    title: 'Weekend hike: Point Reyes',
    mode: 'independent',
    activeModelSlotId: 'model-2',
    messages: [],
    createdAt: NOW - 72 * 60 * MIN,
    updatedAt: NOW - 71 * 60 * MIN
  }
]

/** A quiet evening exchange: the kind of conversation VIBE is for. */
function vibeConversation() {
  return {
    id: 'convo-vibe',
    title: 'Winding down',
    mode: 'independent',
    activeModelSlotId: 'model-1',
    createdAt: NOW - 9 * MIN,
    updatedAt: NOW,
    messages: [
      {
        id: 'v1',
        role: 'user',
        content: "Long day. I can't stop running through tomorrow's presentation in my head.",
        createdAt: NOW - 9 * MIN
      },
      {
        id: 'v2',
        role: 'assistant',
        roleName: 'Assistant',
        modelId: 'qwen3-32b',
        color: 'blue',
        content:
          'That loop is exhausting — your mind rehearsing something it can’t finish tonight. Write the three points you most want to land on a card, then turn it face down. Tomorrow-you can pick it up; tonight-you is off duty.',
        createdAt: NOW - 8 * MIN
      },
      {
        id: 'v3',
        role: 'user',
        content: 'Okay. One thing to do before bed?',
        createdAt: NOW - 2 * MIN
      },
      {
        id: 'v4',
        role: 'assistant',
        roleName: 'Assistant',
        modelId: 'qwen3-32b',
        color: 'blue',
        content:
          'Breathe out longer than you breathe in — four counts in, six out, for two minutes. It tells your body the day is done. Then lights off.',
        createdAt: NOW - 1 * MIN
      }
    ]
  }
}

/** A finished agent turn: two bugs found, fixed after review, verified by the tests. */
function agentConversation() {
  const diff1 = [
    '--- src/stats.js',
    '+++ src/stats.js',
    '@@ -1,6 +1,6 @@',
    ' function mean(xs) {',
    '   let total = 0',
    '-  for (let i = 1; i < xs.length; i++) total += xs[i]',
    '+  for (let i = 0; i < xs.length; i++) total += xs[i]',
    '   return total / xs.length',
    ' }'
  ].join('\n')
  const diff2 = [
    '--- src/stats.js',
    '+++ src/stats.js',
    '@@ -5,7 +5,7 @@',
    ' function median(xs) {',
    '-  const s = [...xs].sort()',
    '+  const s = [...xs].sort((a, b) => a - b)',
    '   const mid = Math.floor(s.length / 2)'
  ].join('\n')
  const records = [
    { id: 'r1', name: 'read_file', args: { path: 'test.js' }, status: 'done', result: "    1\tconst assert = require('assert')" },
    { id: 'r2', name: 'read_file', args: { path: 'src/stats.js' }, status: 'done', result: '    1\tfunction mean(xs) {' },
    { id: 'r3', name: 'edit_file', args: { path: 'src/stats.js' }, status: 'done', result: `Applied to src/stats.js: +1 −1 in 1 hunk.\n\n${diff1}` },
    { id: 'r4', name: 'run_command', args: { command: 'node test.js' }, status: 'error', result: '$ node test.js\nAssertionError [ERR_ASSERTION]: 2 !== 10\n(exit code 1, 0.4 s)' },
    { id: 'r5', name: 'edit_file', args: { path: 'src/stats.js' }, status: 'done', result: `Applied to src/stats.js: +1 −1 in 1 hunk.\n\n${diff2}` },
    { id: 'r6', name: 'run_command', args: { command: 'node test.js' }, status: 'done', result: '$ node test.js\nall tests passed\n(exit code 0, 0.4 s)' }
  ]
  const answer =
    'Both bugs were in `src/stats.js`:\n\n1. **`mean`** started its loop at index 1, skipping the first value.\n2. **`median`** sorted numbers as strings — `[10, 2, 33]` stayed in that order. It now sorts numerically.\n\n`node test.js` passes.'
  return {
    id: 'convo-agent',
    title: '⚡ The tests in test.js fail — fix src/stats.js',
    mode: 'independent',
    activeModelSlotId: 'model-1',
    agent: { workspace: '/Users/colin/code/stats-demo', permission: 'ask' },
    createdAt: NOW - 14 * MIN,
    updatedAt: NOW - 1 * MIN,
    messages: [
      { id: 'g1', role: 'user', content: 'The tests in test.js fail. Find the bugs in src/stats.js, fix them, and run the tests to make sure they pass.', createdAt: NOW - 14 * MIN },
      {
        id: 'g2',
        role: 'assistant',
        roleName: 'Assistant',
        modelId: 'qwen3-32b',
        color: 'blue',
        content: answer,
        toolCalls: records,
        agent: {
          taskId: 'task-demo',
          status: 'done',
          workspace: '/Users/colin/code/stats-demo',
          permission: 'ask',
          startedAt: NOW - 13 * MIN,
          endedAt: NOW - 1 * MIN,
          completionTokens: 3180,
          changedFiles: ['src/stats.js'],
          todos: [
            { content: 'Read the test and the source', status: 'completed' },
            { content: 'Fix mean() off-by-one', status: 'completed' },
            { content: 'Fix median() numeric sort', status: 'completed' },
            { content: 'Run the tests', status: 'completed' }
          ],
          steps: [
            { kind: 'text', text: 'I will read the test first, then the module it tests.' },
            { kind: 'tool', callId: 'r1' },
            { kind: 'tool', callId: 'r2' },
            { kind: 'text', text: '`mean` skips the first element. Fixing that first:' },
            { kind: 'tool', callId: 'r3' },
            { kind: 'tool', callId: 'r4' },
            { kind: 'text', text: 'Still failing — `median([10, 2, 33])` returns 2, so the sort compares as strings.' },
            { kind: 'tool', callId: 'r5' },
            { kind: 'tool', callId: 'r6' },
            { kind: 'text', text: answer }
          ]
        },
        createdAt: NOW - 13 * MIN
      }
    ]
  }
}

function conversations() {
  if (AGENT) return [agentConversation(), ...SIDEBAR_CONVOS]
  if (SCENE === 'vibe-empty') return []
  if (VIBE) return [vibeConversation()]
  if (SCENE.startsWith('welcome')) {
    return [
      {
        id: 'convo-new',
        title: 'New conversation',
        mode: 'independent',
        activeModelSlotId: 'model-1',
        messages: [],
        createdAt: NOW,
        updatedAt: NOW
      },
      ...SIDEBAR_CONVOS
    ]
  }
  return [financeConversation(), ...SIDEBAR_CONVOS]
}

// ------------------------------------------------------------- IPC stubs

const STUBS = {
  'store:setSettings': true,
  'dialog:pickDirectory': null,
  'dialog:pickFile': null,
  'conversations:save': true,
  'conversations:delete': true,
  'conversations:exportMarkdown': { ok: false, canceled: true },
  'tools:list': [],
  'tools:execute': { ok: false, error: 'screenshot stub' },
  'models:pin': true,
  'chat:summarize': { ok: false, error: 'screenshot stub' },
  'app:getVersion': '1.0.0',
  'search:test': { ok: true, detail: 'screenshot stub' },
  'search:braveKeyStatus': { set: false, encrypted: false },
  'search:setBraveApiKey': { ok: true },
  'research:stats': { pages: 0, chunks: 0, chars: 0, embeddedChunks: 0, searchQueries: 0 },
  'research:clear': { pages: 0, entries: 0 },
  'net:getActivity': [],
  'net:clearActivity': true,
  'net:proxyStatus': { mode: 'none', description: 'Direct connection' },
  'net:testProxy': { ok: true, detail: 'screenshot stub' },
  'attachments:pick': { attachments: [], rejected: [], audioPaths: [] },
  'attachments:load': { attachments: [], rejected: [], audioPaths: [] },
  'voice:sttStatus': {
    available: true,
    cliPath: '/opt/homebrew/bin/whisper-cli',
    modelPath: '/Users/colin/.cache/whisper/ggml-base.en.bin'
  },
  'voice:transcribe': { ok: false, error: 'screenshot stub' },
  'voice:transcribeFile': { ok: false, error: 'screenshot stub' },
  'memory:stats': {
    available: true,
    embeddingModel: 'text-embedding-nomic-embed-text-v1.5',
    mixedModels: false,
    totalChunks: 842,
    sources: [
      { source: 'household-budget-2026.md', chunks: 34, updatedAt: NOW - 86400_000 },
      { source: 'card-statement-june.pdf', chunks: 12, updatedAt: NOW - 86400_000 },
      { source: 'company-handbook.pdf', chunks: 796, updatedAt: NOW - 2 * 86400_000 }
    ]
  },
  'memory:search': { ok: true, results: [] },
  'memory:addDocument': { ok: true, chunks: 0 },
  'memory:addDocumentFromPath': { ok: true, name: 'stub', chunks: 0 },
  'memory:delete': { ok: true, removed: 0 },
  'audit:status': { available: true, enabled: false, currentSessionId: 'shot', sessions: [] },
  'audit:record': true,
  'audit:export': { ok: false, canceled: true },
  'audit:purge': { removed: 0 },
  'plan:generate': { ok: false, error: 'screenshot stub' },
  'updates:getStatus': { state: 'dev', currentVersion: '1.0.0' },
  'updates:check': { state: 'dev', currentVersion: '1.0.0' },
  'updates:install': true
}

function registerStubs() {
  ipcMain.handle('store:getSettings', () => settings())
  ipcMain.handle('store:resetSettings', () => settings())
  ipcMain.handle('conversations:list', () => conversations())
  ipcMain.handle('models:catalog', () => CATALOG)
  for (const [channel, value] of Object.entries(STUBS)) {
    ipcMain.handle(channel, () => value)
  }
}

// ---------------------------------------------------------------- capture

function capture(win) {
  // Let React mount, fonts load, and the entrance animations (0.4s) finish.
  setTimeout(async () => {
    try {
      if (SETTINGS_TAB) {
        // The gear, then the tab by its key. The modal fades up over 0.22s;
        // a hidden window may not paint it, so the settings scenes show the
        // window (inactive) — see app.whenReady below.
        await win.webContents.executeJavaScript(`(() => {
          const gear = [...document.querySelectorAll('button')].find((b) => (b.title || '').startsWith('Settings'))
          if (gear) gear.click()
          return !!gear
        })()`)
        await new Promise((r) => setTimeout(r, 800))
        await win.webContents.executeJavaScript(`(() => {
          const tab = document.querySelector('[data-tab="${SETTINGS_TAB}"]')
          if (tab) tab.click()
          return !!tab
        })()`)
        await new Promise((r) => setTimeout(r, 900))
      }
      const image = await win.webContents.capturePage()
      fs.mkdirSync(OUT_DIR, { recursive: true })
      const file = path.join(OUT_DIR, `${SCENE}.png`)
      fs.writeFileSync(file, image.toPNG())
      const { width, height } = image.getSize()
      console.log(`captured ${file} (${width}x${height})`)
      app.exit(0)
    } catch (err) {
      console.error('capture failed:', err)
      app.exit(1)
    }
  }, VIBE ? 4500 : 3000)
}

app.whenReady().then(() => {
  registerStubs()
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: THEME === 'dark' || VIBE ? '#000000' : '#f4f4f5',
    // The lagoon is drawn by requestAnimationFrame, which a hidden window
    // would otherwise throttle to nothing before the capture.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.on('did-finish-load', () => {
    if (SETTINGS_TAB) win.showInactive()
    capture(win)
  })
  void win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
})
