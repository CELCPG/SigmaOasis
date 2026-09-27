/**
 * MCP environment values, measured where the promise is made: in config.json,
 * on disk, under the shipped build.
 *
 * Through v2.8 a server's environment values were a field of its settings row,
 * and the privacy audit said — as a constant — that they were "never written to
 * the settings file in clear". test/mcpEnv.test.ts pins the pieces of the v2.9
 * fix; this check boots the real `out/main` on a throwaway profile and reads the
 * bytes the pieces are supposed to produce, because the claim is about a file
 * and only the file can settle it:
 *
 *   - A pre-v2.9 profile, seeded with a value in a server row, starts once and
 *     the value is gone from the settings key — lifted into the secrets store,
 *     sealed by the keychain where there is one and marked where there is not.
 *   - The renderer's `getSettings` carries names and no value, and its
 *     `secretsStatus` counts the entry without opening it.
 *   - A server added through the same IPC the MCP tab uses — values and all —
 *     lands the same way, and an update from the renderer's copy of the row,
 *     which has no values to send, neither loses the names nor writes a value.
 *   - The value still reaches the process it is for: the added server is a
 *     one-line program that writes its environment variable to a file, and the
 *     file must hold the value. A store that kept secrets by losing them would
 *     pass every line above this one.
 *   - Removing the server removes its entry, and saving the search API key —
 *     whose setter used to replace the whole secrets key — leaves the MCP
 *     entries standing.
 *
 * Both keychain paths are real: macOS and Windows seal; the Linux CI runner has
 * no secret service, so there the check asserts the marked-unencrypted path the
 * privacy audit warns about. Either way the settings key must never hold a value.
 *
 * Run through scripts/test-render.sh (Electron proper, not ELECTRON_RUN_AS_NODE).
 */
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const LEGACY = 'tok-legacy-5e1f0a2d'
const ADDED = 'tok-added-9b2c4471'
const BRAVE = 'brave-key-c3d80e'

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

/** A profile as v2.8 left it: one server whose token sits in its settings row. */
function seedProfile(): string {
  const profile = mkdtempSync(join(tmpdir(), 'sigma-mcp-secrets-'))
  const settings = {
    // A port nothing is listening on: nothing here depends on a model.
    baseUrl: 'http://127.0.0.1:65533/v1',
    onboardingCompleted: true,
    updates: { autoCheck: false },
    audit: { enabled: false, autoPurgeOnQuit: false },
    mcp: {
      servers: [
        {
          id: 'legacy',
          name: 'Legacy',
          command: 'npx',
          args: ['-y', 'some-server'],
          env: { LEGACY_TOKEN: LEGACY },
          enabled: false,
          disabledTools: [],
          approval: 'ask'
        }
      ]
    }
  }
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ settings }, null, 2))
  mkdirSync(join(profile, 'conversations'), { recursive: true })
  return profile
}

async function main(): Promise<void> {
  const profile = seedProfile()
  app.setPath('userData', profile)
  const configFile = join(profile, 'config.json')
  const onDisk = (): { settings: Record<string, unknown>; secrets?: { mcpEnv?: Record<string, { values: string; unencrypted?: boolean }>; braveApiKey?: string } } =>
    JSON.parse(readFileSync(configFile, 'utf8'))

  // Adding a server confirms in a native dialog; answer it as a person pressing
  // "Add (switched off)" would. Nothing else in this check raises one.
  dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox

  // The app shows its window on `ready-to-show`; a test suite must not throw
  // one on the user's screen, and nothing here needs it painted.
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
  await new Promise((r) => setTimeout(r, 1500))
  const api = <T>(call: string): Promise<T> => wc.executeJavaScript(`window.api.${call}`) as Promise<T>

  const sealing = safeStorage.isEncryptionAvailable()
  console.log(`\nkeychain on this machine: ${sealing ? 'available — values are sealed' : 'unavailable — values are stored marked, and the audit warns'}`)

  // --- a v2.8 profile, started once -----------------------------------------
  console.log('\nmigration of a pre-v2.9 profile')
  let disk = onDisk()
  const legacyRow = (disk.settings.mcp as { servers: Record<string, unknown>[] }).servers.find((s) => s.id === 'legacy')
  check('the value left the settings key', !JSON.stringify(disk.settings).includes(LEGACY))
  check('the row carries the name and no env field', JSON.stringify(legacyRow?.envNames) === '["LEGACY_TOKEN"]' && !('env' in (legacyRow ?? {})), JSON.stringify(legacyRow))
  const legacySealed = disk.secrets?.mcpEnv?.legacy
  check('the value is in the secrets store', Boolean(legacySealed))
  if (sealing) {
    check('sealed: the stored bytes are not the value', Boolean(legacySealed) && !JSON.stringify(legacySealed).includes(LEGACY) && !legacySealed?.unencrypted)
  } else {
    check('no keychain: stored, and marked unencrypted', legacySealed?.unencrypted === true)
  }

  // --- what the renderer holds ------------------------------------------------
  console.log('\nwhat the renderer is handed')
  const settings = await api<{ mcp: { servers: Record<string, unknown>[] } }>('getSettings()')
  check('getSettings carries no value', !JSON.stringify(settings).includes(LEGACY))
  check('getSettings carries the name', JSON.stringify(settings.mcp.servers[0]?.envNames) === '["LEGACY_TOKEN"]')
  const status = await api<{ mcpEnv: { servers: number; unencrypted: number; unreadable: string[] } }>('secretsStatus()')
  check(
    'secretsStatus counts the entry and opens none',
    status.mcpEnv.servers === 1 && status.mcpEnv.unencrypted === (sealing ? 0 : 1) && status.mcpEnv.unreadable.length === 0 && !JSON.stringify(status).includes(LEGACY),
    JSON.stringify(status)
  )

  // --- a server added the way the MCP tab adds one -------------------------------
  console.log('\na server added through the MCP tab’s IPC')
  const probeFile = join(profile, 'probe.txt')
  const script = `require('fs').writeFileSync(${JSON.stringify(probeFile)}, process.env.ADDED_TOKEN || 'missing')`
  const draft = {
    id: 'probe',
    name: 'Probe',
    command: process.execPath,
    args: ['-e', script],
    env: { ADDED_TOKEN: ADDED, ELECTRON_RUN_AS_NODE: '1' },
    enabled: false,
    disabledTools: [],
    approval: 'ask'
  }
  const added = await api<{ ok: boolean; server?: Record<string, unknown>; warning?: string; error?: string }>(`mcpAdd(${JSON.stringify(draft)})`)
  check('the add succeeded', added.ok, added.error)
  check('what the add hands back has names, no value', !JSON.stringify(added.server).includes(ADDED) && JSON.stringify(added.server?.envNames) === '["ADDED_TOKEN","ELECTRON_RUN_AS_NODE"]')
  check('a warning exactly when there is no keychain', sealing ? added.warning === undefined : /without encryption/.test(added.warning ?? ''), String(added.warning))
  disk = onDisk()
  check('the added value is not in the settings key', !JSON.stringify(disk.settings).includes(ADDED))
  check('the added value is in the secrets store', Boolean(disk.secrets?.mcpEnv?.probe))
  if (sealing) check('…sealed', !JSON.stringify(disk.secrets?.mcpEnv?.probe).includes(ADDED))

  // Switched on from the renderer's own copy of the row — the path the tab's
  // checkbox takes. That copy has no values to send.
  const row = (await api<{ mcp: { servers: Record<string, unknown>[] } }>('getSettings()')).mcp.servers.find((s) => s.id === 'probe')
  const updated = await api<{ ok: boolean; error?: string }>(`mcpUpdate(${JSON.stringify({ ...row, enabled: true })})`)
  check('the update succeeded', updated.ok, updated.error)
  const until = Date.now() + 15_000
  while (!existsSync(probeFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
  const received = existsSync(probeFile) ? readFileSync(probeFile, 'utf8') : '(the process never ran)'
  check('the spawned server received the value from the keychain', received === ADDED, `it saw ${JSON.stringify(received)}`)
  disk = onDisk()
  const probeRow = (disk.settings.mcp as { servers: Record<string, unknown>[] }).servers.find((s) => s.id === 'probe')
  check('the update kept the names and wrote no value', JSON.stringify(probeRow?.envNames) === '["ADDED_TOKEN","ELECTRON_RUN_AS_NODE"]' && !JSON.stringify(disk.settings).includes(ADDED))

  // --- the other writers of the secrets key -------------------------------------
  console.log('\nremoval, and the search key beside them')
  await api('mcpUpdate(' + JSON.stringify({ ...row, enabled: false }) + ')')
  await api(`mcpRemove('probe')`)
  disk = onDisk()
  check('removing the server removed its entry', !disk.secrets?.mcpEnv?.probe && !JSON.stringify(disk).includes(ADDED))
  await api(`setBraveApiKey(${JSON.stringify(BRAVE)})`)
  check('saving the search key leaves the MCP entries standing', Boolean(onDisk().secrets?.mcpEnv?.legacy))
  await api(`setBraveApiKey('')`)
  disk = onDisk()
  check('clearing it does too, and clears only itself', Boolean(disk.secrets?.mcpEnv?.legacy) && !disk.secrets?.braveApiKey)

  console.log(`\n${'='.repeat(58)}`)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* a leftover temp profile is not worth failing a run over */
  }
  if (failures.length === 0) {
    console.log(`ALL ${passed} MCP-SECRETS CHECKS PASSED`)
    app.exit(0)
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`)
    for (const f of failures) console.log(`  - ${f}`)
    app.exit(1)
  }
}

main().catch((err) => {
  console.error('MCP-SECRETS CHECK ERROR:', err)
  app.exit(1)
})
