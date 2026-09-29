/**
 * Every control has a name a screen reader can say — measured on the
 * shipped build's own accessibility tree (v4.0, E5).
 *
 * An icon button whose only content is a glyph is announced as "button", and
 * the app has grown many of them: the rail's ✕ and «, the composer's 📎 and
 * 🎙️, a message's ↻ and 📋, a pane's ⌘\. A scrape of `aria-label` attributes
 * cannot judge this — a name can come from text, from `aria-labelledby`, from
 * a `title` — so the check does what planAccessibilityCheck does: boots
 * `out/main` on a throwaway profile, opens the surfaces a session uses (the
 * front door, a conversation, Settings, the palette), reads
 * `Accessibility.getFullAXTree` over CDP, and refuses any button, link, tab,
 * switch, textbox or combobox whose computed name is empty.
 *
 * The true negative it guards against: a build that names every icon button
 * "button" scores nothing here — a name that is the role's own word is
 * refused too.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const NAMED_ROLES = new Set(['button', 'link', 'tab', 'switch', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'slider', 'searchbox', 'spinbutton'])
/** A name that is only the role's own word, or a bare glyph, is not a name. */
const NOT_A_NAME = /^(button|link|tab|switch|textbox|combobox|checkbox|radio|slider|[^\p{L}\p{N}]*)$/u

interface Offence {
  surface: string
  role: string
  name: string
  hint: string
}

interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  properties?: { name: string; value: { value?: unknown } }[]
  backendDOMNodeId?: number
}

function seedProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'sigma-button-names-'))
  const now = Date.now()
  writeFileSync(
    join(profile, 'config.json'),
    JSON.stringify(
      {
        settings: {
          baseUrl: 'http://127.0.0.1:65533/v1',
          onboardingCompleted: true,
          theme: 'dark',
          updates: { autoCheck: false },
          audit: { enabled: false, autoPurgeOnQuit: false },
          mcp: { servers: [{ id: 'fs', name: 'Filesystem', command: 'npx', args: [], env: {}, enabled: false, disabledTools: [], approval: 'ask' }] },
          projects: [{ id: 'proj-1', name: 'Field notes', color: 'blue', instructions: '', createdAt: now - 100_000, files: [], defaults: {} }]
        }
      },
      null,
      2
    )
  )
  // One conversation with a reply, so a message's action row is on screen. One file per conversation, as the store keeps them.
  mkdirSync(join(profile, 'conversations'), { recursive: true })
  writeFileSync(
    join(profile, 'conversations', 'c1.json'),
    JSON.stringify({
      id: 'c1',
      title: 'A reply to read',
      mode: 'independent',
      activeModelSlotId: 'model-1',
      messages: [
        { id: 'u1', role: 'user', content: 'Say hello.', createdAt: now - 60_000 },
        { id: 'a1', role: 'assistant', content: 'Hello. What can I do for you today?', createdAt: now - 50_000, modelSlotId: 'model-1' }
      ],
      createdAt: now - 70_000,
      updatedAt: now - 50_000
    })
  )
  return profile
}

async function main(): Promise<void> {
  const profile = seedProfile()
  app.setPath('userData', profile)
  let win: BrowserWindow | null = null
  app.on('browser-window-created', (_e, created) => {
    win = created
    created.show = (): void => {}
    created.showInactive = (): void => {}
  })
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(join(__dirname, '..', '..', 'out', 'main', 'index.js'))
  await app.whenReady()
  const deadline = Date.now() + 20_000
  while (!win && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  if (!win) throw new Error('the app created no window')
  const wc = (win as BrowserWindow).webContents
  await new Promise<void>((r) => {
    if (!wc.isLoading()) return r()
    wc.once('did-finish-load', () => r())
  })
  await new Promise((r) => setTimeout(r, 2500))
  const evalIn = <T>(code: string): Promise<T> => wc.executeJavaScript(code) as Promise<T>
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Accessibility.enable')
  await wc.debugger.sendCommand('DOM.enable')

  const offences: Offence[] = []
  const counted: Record<string, number> = {}
  const read = async (surface: string): Promise<void> => {
    await wc.capturePage(undefined, { stayHidden: true })
    const { nodes } = (await wc.debugger.sendCommand('Accessibility.getFullAXTree')) as { nodes: AxNode[] }
    let n = 0
    for (const node of nodes) {
      if (node.ignored) continue
      const role = node.role?.value ?? ''
      if (!NAMED_ROLES.has(role)) continue
      n += 1
      const name = (node.name?.value ?? '').trim()
      if (!name || NOT_A_NAME.test(name)) {
        let hint = ''
        try {
          const { outerHTML } = (await wc.debugger.sendCommand('DOM.getOuterHTML', { backendNodeId: node.backendDOMNodeId })) as { outerHTML: string }
          hint = outerHTML.replace(/\s+/g, ' ').slice(0, 90)
        } catch {
          hint = '(no DOM node)'
        }
        offences.push({ surface, role, name, hint })
      }
    }
    counted[surface] = n
  }

  // 1. The front door, on the cold start.
  await read('the front door')

  // 2. A conversation with a reply: the rail's rows, the header, the message's action row, the composer.
  await evalIn<boolean>(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'A reply to read'); if (b) b.click(); return !!b })()`)
  await wait(800)
  await read('a conversation')

  // 3. Settings, every tab.
  await evalIn<boolean>(`(() => { const b = document.querySelector('[title^="Settings"]'); if (b) b.click(); return !!b })()`)
  await wait(900)
  const tabs = await evalIn<string[]>(`[...document.querySelectorAll('[data-settings-rail] [data-tab]')].map((b) => b.getAttribute('data-tab'))`)
  for (const tab of tabs) {
    await evalIn<number>(`(() => { const b = document.querySelector('[data-tab="${tab}"]'); if (b) b.click(); return 1 })()`)
    await wait(300)
    await evalIn<number>(`(() => { document.querySelectorAll('.tab-face [data-kit="fold"][aria-expanded="false"]').forEach((b) => b.click()); return 1 })()`)
    await wait(250)
    await read(`Settings → ${tab}`)
  }
  await evalIn<number>(`(() => { const b = document.querySelector('[aria-label="Close settings"]'); if (b) b.click(); return 1 })()`)
  await wait(400)

  // 4. The palette.
  wc.focus()
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] } as never)
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'k', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] } as never)
  await wait(500)
  await read('the palette')

  let passed = 0
  const failures: string[] = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    if (ok) {
      passed += 1
      console.log(`  ok   ${name}`)
    } else {
      failures.push(name + (detail ? ` — ${detail}` : ''))
      console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }
  console.log('')
  for (const [surface, n] of Object.entries(counted)) console.log(`  ${surface}: ${n} named-role nodes`)
  for (const o of offences) console.log(`  ${o.surface} · ${o.role} "${o.name}" · ${o.hint}`)
  console.log('')
  check('the front door, a conversation, every Settings tab and the palette were read', Object.keys(counted).length >= 4 + 10, Object.keys(counted).join(', '))
  check('every surface had controls to read', Object.values(counted).every((n) => n > 0))
  for (const surface of Object.keys(counted)) {
    const here = offences.filter((o) => o.surface === surface)
    check(`${surface}: every control has a name a screen reader can say`, here.length === 0, here.map((o) => `${o.role} "${o.name}"`).join('; '))
  }

  console.log(`\n${'='.repeat(58)}`)
  if (failures.length === 0) console.log(`ALL ${passed} BUTTON-NAME CHECKS PASSED`)
  else {
    console.log(`${failures.length} BUTTON-NAME CHECK(S) FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
  }
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* a leftover temp profile is not worth failing a run over */
  }
  app.exit(failures.length === 0 ? 0 : 1)
}

// Straight away, not inside whenReady: the app's main registers its scheme
// before the app is ready, so it has to be required before that point.
main().catch((err) => {
  console.error(err)
  app.exit(1)
})
