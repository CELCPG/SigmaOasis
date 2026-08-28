/**
 * Measures the contrast of a real assistant reply — prose *and* chrome — in a
 * real window, in both themes.
 *
 * Why it cannot be a node:test file, and why it must not measure the CSS
 * variables on their own: the app dresses its chrome in Tailwind utilities and
 * every one of them sits on a *stack* of translucent surfaces — a glass panel
 * over the canvas, a tinted pill over the panel, a disclosure well over that.
 * What the eye gets is the composite. A check that reads `--text-secondary`
 * out of index.css and calls it a pass certifies a property the shipped app
 * does not have: the ink it measured is not the ink the app renders.
 *
 * So: compile the real stylesheet with the real Tailwind config, take every
 * chrome class string out of the components themselves (never a copy — see
 * PICK), lay the message out, and composite each text node's colour over every
 * background above it. WCAG 2.1 relative luminance, AA at 4.5:1.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { ACCENT } from '../src/renderer/src/lib/colors'
import { toolVisualForName } from '../src/renderer/src/lib/oasisRipple'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const postcss = require('postcss')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tailwindcss = require('tailwindcss')

const REPO = join(__dirname, '..', '..')
const CSS_PATH = join(REPO, 'src/renderer/src/assets/index.css')
const COMPONENTS = join(REPO, 'src/renderer/src/components')
const RENDERER = join(REPO, 'src/renderer/src')

/** AA for body text. Nothing below this may carry information. */
const AA = 4.5

interface Measured {
  id: string
  fg: string
  bg: string
  ratio: number
}

const bubble = readFileSync(join(COMPONENTS, 'MessageBubble.tsx'), 'utf8')
const reasoning = readFileSync(join(COMPONENTS, 'ReasoningBlock.tsx'), 'utf8')
const sidebar = readFileSync(join(COMPONENTS, 'Sidebar.tsx'), 'utf8')
const appRoot = readFileSync(join(RENDERER, 'App.tsx'), 'utf8')
// v2.2: the components that carry the app's bad news. A reply can be perfect
// and the sentence telling you it failed still be the one thing on screen
// nobody can read — which is exactly what it was.
const inputBar = readFileSync(join(COMPONENTS, 'InputBar.tsx'), 'utf8')
const toolCall = readFileSync(join(COMPONENTS, 'ToolCallBlock.tsx'), 'utf8')
const claimCheck = readFileSync(join(COMPONENTS, 'ClaimCheckBlock.tsx'), 'utf8')
const secondOpinion = readFileSync(join(COMPONENTS, 'SecondOpinionBlock.tsx'), 'utf8')
const ranCode = readFileSync(join(COMPONENTS, 'RanCodeBlock.tsx'), 'utf8')
const settings = readFileSync(join(COMPONENTS, 'SettingsModal.tsx'), 'utf8')

/** Every renderer source file, so the raw-neutral guard has nowhere to hide. */
function rendererSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return rendererSources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/** The section of MessageBubble that renders one piece of chrome. */
function section(from: string, to: string): string {
  const start = bubble.indexOf(from)
  if (start < 0) return ''
  const end = bubble.indexOf(to, start)
  return bubble.slice(start, end < 0 ? bubble.length : end)
}

/**
 * Every chrome class string is *read out of the component*, never restated
 * here. A colour swap therefore shows up in the measurement rather than in a
 * stale copy, and a structural rewrite fails the extraction outright instead
 * of leaving the fixture quietly testing something the app stopped rendering.
 */
const PICK: Record<string, { source: string; re: RegExp; wrap?: (s: string) => string }> = {
  // The canvas and its default ink. Restated here it drifted silently — and
  // worse, Tailwind only emits a utility some renderer source actually uses, so
  // a stale copy stops resolving at all and measures inherited black.
  appShell: { source: appRoot, re: /className="(relative flex h-screen bg-base-light[^"]*)"/ },
  bubble: { source: bubble, re: /className=\{`(glass-panel[^`$]*)/ },
  badge: { source: bubble, re: /className=\{`(inline-flex items-center gap-1\.5[^`$]*)/ },
  modelId: { source: bubble, re: /className="(font-mono text-xs [^"]*)">\{message\.modelId\}/ },
  actionRow: { source: bubble, re: /className="(mb-1 flex flex-wrap[^"]*)"/ },
  actionButton: { source: bubble, re: /onClick=\{copyMessage\}\s*\n\s*className="([^"]*)"/ },
  timestamp: { source: bubble, re: /className="(ml-auto px-1\.5 text-\[10px\][^"]*)"/ },
  branchButton: {
    source: readFileSync(join(COMPONENTS, 'BranchMenu.tsx'), 'utf8'),
    re: /className="(ml-2 rounded-md p-1 [^"]*)"/
  },
  reasoningShell: { source: reasoning, re: /className="(my-2 overflow-hidden[^"]*)"/ },
  reasoningButton: { source: reasoning, re: /className="(flex w-full items-center gap-2[^"]*)"/ },
  reasoningLabel: {
    source: reasoning,
    re: /className=\{`font-medium \$\{isStreaming \? 'shimmer-text' : '([^']*)'\}`\}/,
    wrap: (s) => `font-medium ${s}`
  },
  reasoningCaret: { source: reasoning, re: /className="(ml-auto [^"]*)">\{open/ },
  prose: { source: bubble, re: /className="(markdown-body[^"]*)"/ },
  provenanceRow: {
    source: section('function MemoryContextLine', 'function formatStats'),
    re: /className="(mt-2 text-\[11px\][^"]*)"/
  },
  provenanceButton: {
    source: section('function MemoryContextLine', 'function formatStats'),
    re: /className="(rounded px-1\.5[^"]*)"/
  },
  // v1.17.2: the strip's three new pieces of information. The per-entry verdict
  // ("— not cited" / "— cannot tell") is the sentence a reader checks the
  // answer's sourcing against, and the ⚠️ note is the app saying it cannot
  // check it — neither may be the quietest thing on the panel.
  provenanceMark: {
    source: section('function ContextEntry', 'function MemoryContextLine'),
    re: /className="(ml-1 text-ink-[^"]*)"/
  },
  provenanceNote: {
    source: section('function MemoryContextLine', 'function formatStats'),
    re: /<span className="(text-ink-[a-z]+)">\{note\}/
  },
  // …and the inline marker the app could not resolve. Read out of markdown.ts
  // for the same reason every other row is read out of its component: renaming
  // the class must fail the extraction, not quietly measure an unstyled span.
  unresolvedMarker: {
    source: readFileSync(join(RENDERER, 'lib/markdown.ts'), 'utf8'),
    re: /class="(citation-ref citation-unresolved)"/
  },
  stats: {
    source: section('showStats && !isStreaming', '</div>\n      </div>'),
    re: /className="(mt-2 text-\[10px\][^"]*)"/
  },
  // The revision line, both tones. It is the only line on screen that reports
  // on the app's own correction of the answer above it, and after round 4 it
  // has two of them: cleared, and still-faulted. Measuring one would certify
  // half a control — the half that was never the problem.
  revisedResolved: {
    source: section('function RevisedLine', 'v1.5.1 think-harder'),
    re: /\?\s*'(mt-2 text-\[11px\] text-ink-[a-z]+)'/
  },
  revisedUnresolved: {
    source: section('function RevisedLine', 'v1.5.1 think-harder'),
    re: /:\s*'(mt-2 text-\[11px\] text-ink-[a-z]+)'/
  },
  // The amber grounding banner — the one place the app says the answer above it
  // is not supported by anything it ran, and therefore the last place that may
  // be hard to read. Three separate inks, because it had three: the warning,
  // the list of invented links, and the "Checked against" provenance footer.
  groundingBanner: { source: bubble, re: /className="(mt-2 rounded-lg border border-amber-500\/30[^"]*)"/ },
  groundingLinks: { source: bubble, re: /<ul className="(mt-1 list-disc[^"]*)"/ },
  groundingFooter: {
    source: bubble,
    re: /className="(mt-1 text-ink-[a-z]+)">\s*Checked against:/
  },
  // v2.1: the other half of the provenance — not what the answer was measured
  // against but what the pass never measured. Scraped from its own line rather
  // than assumed to share the footer's ink, so dimming just this one fails the
  // extraction instead of quietly measuring the wrong node.
  groundingCoverage: {
    source: bubble,
    re: /\{coverage !== '' && <div className="(mt-1 text-ink-[^"]*)"/
  },
  userTimestamp: {
    source: section("if (message.role === 'user')", 'const accent ='),
    re: /className="(text-\[10px\][^"]*)"/
  },
  // The sidebar is chrome too, and it is where the ink-token sweep stopped: a
  // reply can be perfect while the panel beside it carries the worst contrast
  // on the screen.
  // v2.1: collapsing became an animation, so the rail's width moved into a
  // conditional and the shell's classes are a template literal. Scrape the
  // fixed part and put the open width back — the collapsed rail is glyphs
  // only, and this check is about the ink a panel of prose sits on.
  sidebarShell: {
    source: sidebar,
    re: /<aside\s*\n\s*className=\{`(oasis-rail relative z-10 m-3 mr-0 [^`$]*)\$\{/,
    wrap: (s) => `${s} w-[280px]`
  },
  sidebarSearch: {
    source: sidebar,
    re: /placeholder="Search conversations…"\s*\n\s*className="([^"]*)"/
  },
  versionChip: {
    source: sidebar,
    re: /className="(text-\[10px\][^"]*)" title="Sigma Oasis build version"/
  },

  // ---- v2.2: the app's own bad news ----------------------------------------
  //
  // Every row below is a sentence the app uses to report a failure, a warning,
  // or a claim it could not verify — and as a class they were the least legible
  // text in the product. A blind critic measuring a round-8 capture found the
  // single worst node anywhere was the transport failure sentence, "nothing
  // answered at that address", at 3.63:1: `text-red-500`, which is 3.67:1 on
  // this panel and cannot be anything else, because a raw palette step is one
  // colour for two themes. `text-amber-600` was the same story 25 times over at
  // 3.10:1, including every ⚠️ line that says the answer may be wrong.
  //
  // Half of these do not sit on the panel. They sit on a wash of their own hue —
  // amber/5 under the grounding banner, amber/10 under a settings warning,
  // amber/15 under the second-opinion pill, red/10 under a traceback — and a
  // tint makes the surface *brighter*, so measuring on the bare panel would
  // flatter every one of them. Each row below is laid out on the surface its
  // component actually gives it.
  composerShell: { source: inputBar, re: /className=\{`(glass-panel rounded-3xl[^`$]*)/ },
  composerNotice: { source: inputBar, re: /<span className="(text-ink-[a-z]+)">\{notice\}/ },
  composerBlind: {
    source: inputBar,
    re: /className="(text-ink-[a-z]+)"\s*\n\s*title="LM Studio reports this model as text-only/
  },
  // v1.17.3: the title moved from a constant to the composed failure, because
  // the line itself is no longer a constant — it names whichever party actually
  // fell silent. The class string is scraped off the same node.
  emptyReply: {
    source: bubble,
    re: /className="(text-\[11px\] text-ink-[a-z]+)" title=\{composeFailure\(nothingCame\)\}/
  },
  // …and the remedy that trails it, which is the app telling a reader what to
  // do next about a turn that produced nothing. Quieter than the warning by
  // design, and therefore the half of the line most likely to be unreadable.
  emptyReplyRemedy: {
    source: bubble,
    re: /<span className="(text-ink-[a-z]+)"> \{nothingCame\.remedy\.text\}/
  },
  // The reason a disabled Regenerate is disabled — visible, not title-only, so
  // it must be legible.
  regenerateBlocked: {
    source: bubble,
    re: /<span className="(text-ink-[a-z]+)" title=\{cannotRegenerate\}/
  },
  unverifiedNote: {
    source: bubble,
    re: /className="(mt-2 text-\[11px\] text-ink-[a-z]+)"\s*\n\s*title=\{\s*\n\s*message\.offline/
  },
  truncatedNote: {
    source: bubble,
    re: /className="(mt-2 text-\[11px\] text-ink-[a-z]+)"\s*\n\s*title="The reply reached this role/
  },
  workbenchCheck: {
    source: bubble,
    re: /className=\{c\.ok \? 'text-ink-tertiary' : '(text-ink-[a-z]+)'\}/
  },
  // The tool row: a call that failed, and a call that worked and returned
  // nothing. The shell is an inline style rather than a class — a per-tool
  // wash — so the alpha is scraped and the hue comes from the app's own table.
  toolShell: { source: toolCall, re: /className="(my-2 overflow-hidden rounded-2xl border text-xs)"/ },
  toolShellTint: { source: toolCall, re: /background: `\$\{visual\.color\}([0-9a-f]{2})`/ },
  toolEmptyNote: { source: toolCall, re: /\{empty && <span className="(text-ink-[a-z]+)">/ },
  toolFailure: {
    source: toolCall,
    re: /: 'min-w-0 truncate (text-ink-[a-z]+)'\s*\n?\s*\}/
  },
  claimShell: { source: claimCheck, re: /className="(my-2 overflow-hidden rounded-2xl border border-amber-400[^"]*)"/ },
  claimSummary: { source: claimCheck, re: /className="(min-w-0 font-medium text-ink-[a-z]+)">\{summary\}/ },
  claimContradicted: {
    source: claimCheck,
    re: /label: 'Contradicted',\s*\n\s*classes: '(text-ink-[a-z]+)'/
  },
  claimUnverifiable: {
    source: claimCheck,
    re: /label: 'Unverifiable',\s*\n\s*classes: '(text-ink-[a-z]+)'/
  },
  secondOpinionShell: { source: secondOpinion, re: /className="(my-2 overflow-hidden rounded-2xl border border-violet-400[^"]*)"/ },
  secondOpinionPill: { source: secondOpinion, re: /className="(rounded-full bg-amber-500\/15[^"]*)"/ },
  ranCodeError: { source: ranCode, re: /<pre className="(max-h-72 overflow-auto[^"]*)">\{parsed\.error\}/ },
  settingsWarning: { source: settings, re: /<p className="(mt-2 rounded-lg bg-amber-500\/10 p-3[^"]*)"/ },
  settingsTestFailed: {
    source: settings,
    re: /searchTest\.ok \? 'text-ink-[a-z]+' : '(text-ink-[a-z]+)'/
  },
  settingsTestOk: { source: settings, re: /searchTest\.ok \? '(text-ink-[a-z]+)'/ }
}

const classes: Record<string, string> = {}
const missing: string[] = []
for (const [name, { source, re, wrap }] of Object.entries(PICK)) {
  const m = source.match(re)
  if (!m) {
    missing.push(name)
    classes[name] = ''
  } else {
    classes[name] = (wrap ? wrap(m[1]) : m[1]).trim()
  }
}

function c(name: keyof typeof PICK): string {
  return classes[name]
}

/**
 * The ink a `placeholder:` utility paints, as a class that can be measured.
 * Chromium keeps the placeholder in a UA shadow root, so
 * `getComputedStyle(input, '::placeholder')` reports the input's own colour and
 * a check built on it certifies ink nobody sees. Both strings come out of the
 * same scraped class list, so the probe cannot drift from the control.
 */
function placeholderInk(classList: string): string {
  return classList
    .split(/\s+/)
    .filter((t) => t.startsWith('placeholder:'))
    .map((t) => t.slice('placeholder:'.length))
    .join(' ')
}

/**
 * The tool row's shell is tinted per tool through an inline style, not a class.
 * The hue comes from the app's own table and the alpha is scraped above, so a
 * change to either shows up here rather than in a stale copy.
 */
const TOOL_TINT = toolVisualForName('web_search').color

/**
 * Raw palette ink still used anywhere in the renderer, and the surface to
 * measure it on.
 *
 * The neutral guard below bans `text-neutral-400` and its cousins outright,
 * because a grey that clears AA on one canvas fails on the other. A *hue* is
 * not so simple: the app has two legitimate fixed palettes — which role
 * answered (lib/colors.ts) and which project a conversation belongs to
 * (lib/projects.ts) — and an amber project is not a warning, so painting it in
 * warning ink would be a lie this file could not see. Those may keep raw steps.
 * What they may not do is be illegible, and at -600 they were: 4.25:1 (blue),
 * 4.37 (purple), 3.77 (rose) and 2.78 (amber) — a project's own name.
 *
 * So the rule is measured, not named: any raw palette step used as ink must
 * clear AA on a 15% chip of its own hue, which is the only surface this app
 * ever puts one on. That is strictly harsher than the bare panel, and it is
 * what kills `text-amber-600` (2.78:1) and `text-red-500` (3.17:1) for good —
 * in a label, in a badge, and in the reader-facing prose they were carrying.
 * Status prose does not get a raw step at any darkness: it goes through
 * `text-ink-danger|warn|ok`, and the composited rows above measure it there.
 *
 * A bare utility is checked in light and a `dark:` one in dark, which is how
 * the app pairs them; the pair itself is what the fixture rows verify.
 *
 * The whole variant chain is captured, not just a leading `dark:`. Matching
 * `(dark:)?text-…` after a delimiter class that contained `:` let
 * `dark:hover:text-violet-300` match from the colon of `hover:` with no `dark:`
 * group — a phantom light-theme class, which is 1.50:1 and was reported as a
 * failure of a site that does not exist. A chain is dark if `dark:` is anywhere
 * in it.
 */
const PALETTE_INK =
  /(?:^|[\s"'`{])((?:[a-z][a-z0-9-]*:)*)text-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(\d{3})\b/g

interface RawInk {
  id: string
  cls: string
  hue: string
  dark: boolean
  where: string
}

const rawInks: RawInk[] = (() => {
  const seen = new Map<string, RawInk>()
  for (const path of rendererSources(RENDERER)) {
    const src = readFileSync(path, 'utf8')
    PALETTE_INK.lastIndex = 0
    for (let m = PALETTE_INK.exec(src); m; m = PALETTE_INK.exec(src)) {
      const chain = m[1] ?? ''
      const dark = /(?:^|:)dark:/.test(chain)
      const cls = `text-${m[2]}-${m[3]}`
      const id = `${chain}${cls}`
      if (!seen.has(id)) {
        seen.set(id, { id, cls, hue: m[2]!, dark, where: path.slice(RENDERER.length + 1) })
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
})()

/** One chip per raw step, in the theme that step actually renders in. */
function paletteProbes(dark: boolean): string {
  const rows = rawInks.filter((r) => r.dark === dark)
  if (rows.length === 0) return ''
  return `<div class="glass-panel p-2">${rows
    .map(
      (r) =>
        `<span class="rounded-full bg-${r.hue}-500/15 px-1.5 py-0.5 text-[10px] font-medium ${r.cls}" data-ink="palette: ${r.id}">Project name</span>`
    )
    .join('')}</div>`
}

/**
 * Every text node here carries information the reply depends on: what was
 * consulted, how long it took, which model answered, what each control does,
 * whether a disclosure is open. A purely decorative glyph may sit lighter —
 * the 💭 does — but then it must not be the only thing saying something.
 */
const LOAD_BEARING = [
  'role badge',
  'model id',
  'action: copy',
  'action: branch',
  'timestamp',
  'reasoning label',
  'reasoning caret',
  'prose',
  'prose link',
  'prose quote',
  'library provenance',
  'provenance verdict',
  'provenance note',
  'unresolved citation',
  'revision cleared',
  'revision unresolved',
  'grounding warning',
  'grounding link',
  'grounding coverage',
  'grounding provenance',
  'stats readout',
  'user timestamp',
  'sidebar search placeholder',
  'version chip',
  // v2.2. The app's warnings were its least legible text; these are the rows
  // that say so out loud. A reader who is being told the answer may be wrong is
  // the reader with the least slack, so none of these may be quieter than the
  // prose they are qualifying.
  'composer failure',
  'composer warning',
  'empty reply',
  'unverified answer',
  'truncated answer',
  'workbench check failed',
  'tool empty result',
  'tool failure reason',
  'claim check summary',
  'claim contradicted',
  'claim unverifiable',
  'second opinion unverified',
  'ran code error',
  'settings warning',
  'settings test failed',
  'settings test ok'
]

/**
 * The real bubble: same nesting, same surfaces, same order as the DOM a
 * recorded turn produces — role badge, action row, collapsed reasoning
 * disclosure, prose, the library provenance line, the stats footer, and the
 * user's own timestamp out on the bare canvas.
 */
function fixture(dark: boolean): string {
  return `<!doctype html>
<html lang="en" class="${dark ? 'dark' : ''}"><head><meta charset="utf-8"><style>__CSS__</style>
<!-- Entry animations are transient and \`oasis-enter\` fades opacity in over
     0.4s; now that opacity is measured, a screenshot taken mid-fade would
     report a ratio nobody ever sees for longer than a blink. This suite
     measures the resting state, so it says so rather than racing the clock. -->
<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style></head>
<body>
  <div class="${c('appShell')}">
    <div class="ambient-orbs" aria-hidden="true"></div>
    <aside class="${c('sidebarShell')}">
      <div class="px-4 pb-2">
        <div class="${c('sidebarSearch')}"><span class="${placeholderInk(c('sidebarSearch'))}" data-ink="sidebar search placeholder">Search conversations…</span></div>
      </div>
      <div class="mt-auto flex items-center gap-2 border-t border-black/10 dark:border-white/10 p-4">
        <span class="${c('versionChip')}" data-ink="version chip">v31.7.7</span>
      </div>
    </aside>
    <div class="min-h-0 flex-1 overflow-y-auto pb-8 pt-4">
      <div class="px-4 py-2">
        <div class="mx-auto flex max-w-3xl items-start gap-3">
          <div class="${c('bubble')}">
            <div class="mb-1.5 flex items-center gap-2">
              <span class="${c('badge')} ${ACCENT.blue.badge}" data-ink="role badge"><span class="h-1.5 w-1.5 rounded-full bg-blue-500"></span>Assistant</span>
              <span class="${c('modelId')}" data-ink="model id">qwen3.8-9b</span>
            </div>
            <div class="${c('actionRow')}">
              <button type="button" class="${c('actionButton')}" data-ink="action: copy">📋 Copy</button>
              <button type="button" class="${c('actionButton')}">🔊 Listen</button>
              <button type="button" class="${c('actionButton')}">↻ Regenerate</button>
              <button type="button" class="${c('actionButton')}">🧠 Think harder</button>
              <div class="relative inline-block"><button class="${c('branchButton')}" data-ink="action: branch">🌿</button></div>
              <span class="${c('timestamp')}" data-ink="timestamp">11:14 AM</span>
            </div>
            <div class="${c('reasoningShell')}">
              <button type="button" class="${c('reasoningButton')}">
                <span data-ink="reasoning glyph">💭</span>
                <span class="${c('reasoningLabel')}" data-ink="reasoning label">Thought for 9.6s</span>
                <span class="${c('reasoningCaret')}" data-ink="reasoning caret">▸</span>
              </button>
            </div>
            <div class="${c('prose')}">
              <p data-ink="prose">Poultry reaches a safe internal temperature at 74&nbsp;°C, measured in the thickest part.</p>
              <p><a href="#" data-ink="prose link">The source table</a> lists every cut.</p>
              <blockquote data-ink="prose quote">Rest the meat for three minutes before carving.</blockquote>
              <p>Cook it to 74&nbsp;°C <span class="${c('unresolvedMarker')}" data-ink="unresolved citation">[9]</span>.</p>
            </div>
            <div class="${c('provenanceRow')}">
              <button type="button" class="${c('provenanceButton')}" data-ink="library provenance">📖 From the library: Food safety › Safe minimum internal temperatures (0.72)<span class="${c('provenanceMark')}" data-ink="provenance verdict">— not cited</span> <span class="${c('provenanceNote')}" data-ink="provenance note">⚠️ [9] names no passage listed here, so the rest are left unjudged.</span> ▸</button>
            </div>
            <div class="${c('revisedResolved')}" data-ink="revision cleared">✎ Revised: 1 unsupported item was sent back (165°F); the re-check faults none of them.</div>
            <div class="${c('revisedUnresolved')}" data-ink="revision unresolved">✎ Revised: 2 unsupported items were sent back; 1 is still unsupported in this answer: 165°F.</div>
            <div class="${c('groundingBanner')}">
              <div data-ink="grounding warning">⚠️ 2 measurements (165°F, 74°C) in this reply are not backed by the tool output.</div>
              <ul class="${c('groundingLinks')}"><li class="break-all" data-ink="grounding link">https://www.fsis.usda.gov/safe-minimum-internal-temperature-chart</li></ul>
              <div class="${c('groundingCoverage')}" data-ink="grounding coverage">Covered 1 of the 3 measurements in this reply. Not compared against anything: 4 days, 105 gallons.</div>
              <div class="${c('groundingFooter')}" data-ink="grounding provenance">Checked against: reference_lookup.</div>
            </div>
            <div class="${c('emptyReply')}" data-ink="empty reply">⚠️ You stopped this turn. LM Studio had accepted the request and then sent nothing at all for 90s — the reply never started, so the model had produced nothing to stop.<span class="${c('emptyReplyRemedy')}" data-ink="empty reply remedy"> Ask again. The address is right — the server took the request — so check that the model is still loaded in LM Studio.</span></div>
            <div class="flex flex-wrap items-center gap-1 text-xs text-ink-secondary"><span class="${c('regenerateBlocked')}" data-ink="regenerate blocked">— this request is over the window</span></div>
            <div class="${c('unverifiedNote')}" data-ink="unverified answer">⚠️ Answered from model memory — no sources consulted. Treat names, dates, and numbers as unverified.</div>
            <div class="${c('truncatedNote')}" data-ink="truncated answer">✂️ Cut off at the length cap — this reply is unfinished.</div>
            <div class="mt-2 space-y-0.5 text-[11px]">
              <div class="${c('workbenchCheck')}" data-ink="workbench check failed">🧮 Recompute disagreed: the reply says 165°F, the check gives 74°C.</div>
            </div>
            <div class="${c('toolShell')}" style="border-color: ${TOOL_TINT}30; background: ${TOOL_TINT}${c('toolShellTint')}">
              <div class="flex w-full items-center gap-2 px-3 py-1.5 text-left">
                <span class="min-w-0 truncate font-medium">🔎 reference_lookup</span>
                <span class="${c('toolEmptyNote')}" data-ink="tool empty result">— returned nothing</span>
                <span class="${c('toolFailure')}" data-ink="tool failure reason">— nothing answered at that address</span>
              </div>
            </div>
            <div class="${c('claimShell')}">
              <div class="flex w-full items-center gap-2 px-3 py-1.5 text-left">
                <span class="${c('claimSummary')}" data-ink="claim check summary">2 of 5 claims could not be confirmed</span>
              </div>
              <div class="px-3 pb-2 text-[11px]">
                <div class="${c('claimContradicted')}" data-ink="claim contradicted">✗ Contradicted — the cited table gives 74 °C, not 165 °C.</div>
                <div class="${c('claimUnverifiable')}" data-ink="claim unverifiable">? Unverifiable — no consulted source mentions this.</div>
              </div>
            </div>
            <div class="${c('secondOpinionShell')}">
              <div class="flex w-full items-center gap-2 px-3 py-1.5 text-left">
                <span class="${c('secondOpinionPill')}" data-ink="second opinion unverified">auto — unverified answer</span>
              </div>
            </div>
            <pre class="${c('ranCodeError')}" data-ink="ran code error">Traceback (most recent call last):
  ZeroDivisionError: division by zero</pre>
            <div class="${c('stats')}" data-ink="stats readout">238 tok · 10.1 tok/s · 7.84s to first token · 23.6s total</div>
          </div>
        </div>
      </div>
      <div class="flex flex-col items-end gap-2 px-4 py-2">
        <span class="${c('userTimestamp')}" data-ink="user timestamp">11:14 AM</span>
      </div>
    </div>
    <!-- The settings sheet. Its warning paragraphs sit on a 10% amber wash
         inside a near-opaque popover, which is a different surface again from
         the bubble's 5%. -->
    <div class="glass-popover rounded-2xl p-4">
      <p class="${c('settingsWarning')}" data-ink="settings warning">⚠️ Tools run on this machine with your permissions. Only enable what you need.</p>
      <div class="${c('settingsTestFailed')}" data-ink="settings test failed">✗ nothing answered at that address</div>
      <div class="${c('settingsTestOk')}" data-ink="settings test ok">✓ Reached the provider in 240 ms</div>
    </div>
    <!-- The composer. The failure sentence lands here, on the same glass the
         message list uses, and it is the node the round-8 critic measured at
         3.63:1 — the worst text anywhere in the capture. -->
    <div class="p-4 pt-1">
      <div class="mx-auto max-w-3xl">
        <div class="${c('composerShell')}">
          <div class="mt-1.5 flex justify-between px-1 text-xs">
            <span class="${c('composerNotice')}" data-ink="composer failure">Sigma could not reach the provider — nothing answered at that address.</span>
            <span class="${c('composerBlind')}" data-ink="composer warning">⚠ Scout cannot see images — pick a vision model</span>
          </div>
        </div>
      </div>
    </div>
    ${paletteProbes(dark)}
  </div>
</body></html>`
}

/**
 * Runs in the page. Composites every measured node's colour over the whole
 * stack of backgrounds above it, then reports the WCAG 2.1 ratio.
 *
 * `opacity` counts, and through v1.17 it did not. It is not a colour: it
 * composites the ink — and the surface it sits on — against everything behind
 * them, so `getComputedStyle(el).color` reports a tone the reader never gets.
 * Measured on the grounding banner, whose ink was `text-amber-700` and reads
 * #b45309 either way: the `opacity-75` footer painted with it rendered #c67c43
 * at **3.10:1** and the `opacity-90` link list #bb6320 at **3.99:1** — the two
 * least legible things in the app, on the banner that admits the answer is
 * unsupported, and this suite called them both 4.71:1 and passed them. A critic
 * reading a screenshot of the same footer got 3.06:1.
 *
 * The cumulative factor is gathered root→node so each layer is dimmed by its
 * own opacity and its ancestors', never by its descendants'. Every ratio this
 * can report is ≤ the one the old reading gave; in practice all 36 pre-existing
 * ink rows come back byte-identical, because nothing else dims ink this way.
 */
const MEASURE = `(() => {
  const parse = (s) => {
    const n = (s.match(/[\\d.]+/g) || []).map(Number)
    return [n[0] || 0, n[1] || 0, n[2] || 0, n.length > 3 ? n[3] : 1]
  }
  const over = (fg, bg) => (fg[3] >= 1 ? fg.slice(0, 3) : [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])))
  const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const lum = (c) => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2])
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  // Root → node. \`dim\` at each level is the product of that node's opacity and
  // every ancestor's, which is exactly what reaches the eye there.
  const chain = (el) => {
    const nodes = []
    for (let n = el; n; n = n.parentElement) nodes.push(n)
    nodes.reverse()
    const out = []
    let dim = 1
    for (const n of nodes) {
      const s = getComputedStyle(n)
      const o = parseFloat(s.opacity)
      dim *= Number.isFinite(o) ? o : 1
      const c = parse(s.backgroundColor)
      out.push({ bg: [c[0], c[1], c[2], c[3] * dim], color: s.color, dim })
    }
    return out
  }
  return [...document.querySelectorAll('[data-ink]')].map((el) => {
    const layers = chain(el)
    let bg = [255, 255, 255]
    for (const layer of layers) bg = over(layer.bg, bg)
    const own = layers[layers.length - 1]
    const ink = parse(own.color)
    const fg = over([ink[0], ink[1], ink[2], ink[3] * own.dim], bg)
    return { id: el.getAttribute('data-ink'), fg: hex(fg), bg: hex(bg), ratio: Math.round(ratio(fg, bg) * 100) / 100 }
  })
})()`

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function buildCss(): Promise<string> {
  const source = readFileSync(CSS_PATH, 'utf8')
    // postcss-import is not a dependency, and an unresolvable @import inside a
    // data: document never settles. The highlight.js theme only paints code
    // blocks, which nothing here measures.
    .replace(/^@import .*$/m, '')
  // The app's own config, plus the classes the palette probes need.
  //
  // Tailwind only emits a utility some scanned source actually writes, and the
  // probes write two kinds it may never see. The chip (`bg-violet-500/15`) may
  // be a background no component uses — an unemitted background is a
  // transparent chip, so the ink would be measured on the bare panel and
  // flattered by a full rank. Worse, the *ink*: a step that appears only as
  // `dark:text-amber-400` compiles to `.dark .dark\:text-amber-400` and there
  // is no bare `.text-amber-400` rule at all, so a probe wearing that class
  // inherits the ambient ink and reports 14:1 for a colour it never rendered.
  // Both were true here — eight dark probes and one light one passed on
  // inherited ink until this line existed. Same trap as the appShell PICK
  // above: a class that no longer resolves measures something else entirely
  // and says nothing about it.
  //
  // The safelist is the fixture's, never the app's: it forces classes to exist
  // so they can be measured, and changes no colour the product ships.
  const config = { ...require(join(REPO, 'tailwind.config.js')) }
  config.safelist = [
    ...new Set(rawInks.flatMap((r) => [`bg-${r.hue}-500/15`, r.cls]))
  ]
  const out = await postcss([tailwindcss(config)]).process(source, { from: CSS_PATH })
  return out.css as string
}

async function measure(win: BrowserWindow, css: string, dark: boolean): Promise<Measured[]> {
  const html = fixture(dark).replace('__CSS__', css)
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 200))
  return (await win.webContents.executeJavaScript(MEASURE)) as Measured[]
}

async function main(): Promise<void> {
  const css = await buildCss()

  console.log('\nthe fixture is the app’s own chrome')
  check('every chrome class string was found in its component', missing.length === 0, missing.join(', '))

  // Raw neutral utilities cannot be theme-aware: the grey that clears AA on the
  // black canvas fails on the white one, and vice versa. Chrome ink has to go
  // through the semantic ramp (--text-*), which is defined once per theme.
  console.log('\nchrome ink is theme-aware')
  const RAW_INK = /(?:^|[\s"'`{:])text-(?:neutral|gray|zinc|slate|stone)-\d{3}\b/g
  for (const [file, src] of [
    ['MessageBubble.tsx', bubble],
    ['ReasoningBlock.tsx', reasoning]
  ] as const) {
    const raw = src.match(RAW_INK) ?? []
    check(`${file} sets no chrome ink in a raw neutral`, raw.length === 0, `${raw.length} site(s)`)
  }

  // Two components are not a palette. Retinting the files a critic happens to
  // look at leaves the default for every component written afterwards at
  // neutral-400 — 2.2:1 on the light sidebar — so the guard is the whole
  // renderer or it is nothing.
  const sources = rendererSources(RENDERER)
  check(`the guard scans the whole renderer, not a hand-picked file or two`, sources.length >= 40, `${sources.length} file(s)`)
  const offenders: string[] = []
  let rawSites = 0
  for (const path of sources) {
    const hits = (readFileSync(path, 'utf8').match(RAW_INK) ?? []).length
    if (hits > 0) {
      rawSites += hits
      offenders.push(`${path.slice(RENDERER.length + 1)} (${hits})`)
    }
  }
  check(
    'no renderer source sets ink in a raw neutral',
    offenders.length === 0,
    `${rawSites} site(s) in ${offenders.length} file(s): ${offenders.slice(0, 6).join(', ')}${offenders.length > 6 ? ' …' : ''}`
  )

  // A rank made of `opacity` is a colour nobody chose: it composites the ink
  // against whatever is behind it, so the tone is a property of the surface, not
  // of the design. In the grounding banner it produced 3.10:1 and 3.99:1 out of
  // an ink that measures 4.71:1 on its own — and it did it on the one panel that
  // exists to say the answer above it is unsupported. The measurement below
  // catches the ratio on the two rows the fixture renders; this catches the
  // mechanism, including in the states no fixture renders (a report carrying
  // contacts, or addresses, or quotes).
  // Comments stripped first: the component's own note records the ratios the
  // two dimmed pieces measured, and a guard that its own explanation trips is a
  // guard nobody keeps.
  const banner = section('function GroundingWarning', 'function RevisedLine')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
  const dimmed = banner.match(/\bopacity-\d+/g) ?? []
  check('the grounding banner dims no ink with opacity', dimmed.length === 0, dimmed.join(', '))

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false }
  })

  const themes = [
    { name: 'light', rows: await measure(win, css, false) },
    { name: 'dark', rows: await measure(win, css, true) }
  ]

  for (const theme of themes) {
    console.log(`\n${theme.name} theme — composited contrast of a real reply`)
    for (const row of theme.rows) {
      console.log(`       ${row.ratio.toFixed(2).padStart(6)}:1  ${row.fg} on ${row.bg}  ${row.id}`)
    }
    for (const id of LOAD_BEARING) {
      const row = theme.rows.find((r) => r.id === id)
      check(
        `${theme.name}: “${id}” clears AA`,
        !!row && row.ratio >= AA,
        row ? `${row.ratio.toFixed(2)}:1 (${row.fg} on ${row.bg})` : 'node missing from fixture'
      )
    }
  }

  // The raw palette, measured on the chip it renders on. This is the guard that
  // makes `text-amber-600` and `text-red-500` unusable as ink anywhere in the
  // renderer — the per-site fix without it is how 25 amber sites accumulated.
  console.log('\nno raw palette step is illegible on its own chip')
  check('the palette scan found the raw steps still in use', rawInks.length > 0, `${rawInks.length} step(s)`)
  for (const theme of themes) {
    for (const raw of rawInks.filter((r) => r.dark === (theme.name === 'dark'))) {
      const row = theme.rows.find((r) => r.id === `palette: ${raw.id}`)
      check(
        `${theme.name}: “${raw.id}” clears AA on a ${raw.hue}/15 chip`,
        !!row && row.ratio >= AA,
        row ? `${row.ratio.toFixed(2)}:1 (${row.fg} on ${row.bg}) — ${raw.where}` : 'probe missing'
      )
    }
  }

  // One legible ink everywhere would pass the loop above and flatten the
  // reading order. The reply must still separate prose from chrome and keep
  // more than one rank of chrome.
  console.log('\nhierarchy survives')
  for (const theme of themes) {
    const by = (id: string): Measured =>
      theme.rows.find((r) => r.id === id) ?? { id, fg: '', bg: '', ratio: 0 }
    const prose = by('prose')
    const primary = by('reasoning label')
    const secondary = by('stats readout')
    check(
      `${theme.name}: prose outranks chrome`,
      prose.ratio > primary.ratio + 1,
      `prose ${prose.ratio}:1 vs chrome ${primary.ratio}:1`
    )
    check(
      `${theme.name}: chrome keeps two ranks`,
      primary.fg !== secondary.fg && primary.ratio > secondary.ratio,
      `${primary.fg} (${primary.ratio}:1) vs ${secondary.fg} (${secondary.ratio}:1)`
    )
    // The revision line reports on the app's own correction, and through v1.14
    // it painted both outcomes the same green — including the measured V1 turn
    // where the finding was still standing in the answer above it. Colour is
    // the fastest thing a reader reads; a finding that survived must not wear
    // the colour of one that did not.
    const cleared = by('revision cleared')
    const unresolved = by('revision unresolved')
    check(
      `${theme.name}: a surviving finding is not painted as a resolved one`,
      cleared.fg !== unresolved.fg,
      `both ${cleared.fg}`
    )
    // The banner had ranks before too — they were just made of `opacity`, which
    // is how the quietest of them ended up at 3.10:1. Legibility is the AA loop
    // above; this is only the ordering, and the static `opacity-` guard earlier
    // in this file is what keeps the rank from being made of opacity again.
    const warning = by('grounding warning')
    const provenance = by('grounding provenance')
    check(
      `${theme.name}: the grounding banner keeps two ranks`,
      warning.fg !== provenance.fg && warning.ratio > provenance.ratio,
      `${warning.fg} (${warning.ratio}:1) vs ${provenance.fg} (${provenance.ratio}:1)`
    )
    // v2.1: the coverage line is a statement about the check, not a thirteenth
    // accusation, so it belongs at the provenance rank and not the warning's. A
    // reader who reads "not compared against anything" in the same ink as
    // "not backed by the tool output" has been told the app faulted a figure it
    // did not fault.
    const coverage = by('grounding coverage')
    check(
      `${theme.name}: the coverage line reads as provenance, not as a finding`,
      coverage.fg === provenance.fg && coverage.fg !== warning.fg,
      `${coverage.fg} vs provenance ${provenance.fg} / warning ${warning.fg}`
    )
  }

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) {
    console.log(`ALL ${passed} STYLE CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('STYLE CHECK ERROR:', err)
    app.exit(1)
  })
)
