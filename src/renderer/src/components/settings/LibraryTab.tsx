// Settings → Library (v4.0, S4): the packs as cards with one action order,
// curated packs, and a lookup you can try — the same retrieval the
// reference_lookup tool runs. Everything on this tab is local: disk, plus
// loopback embeddings.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryBundledPack, LibraryFreshness, LibraryLookupResult, LibraryPackSummary } from '../../types'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { ActionRow, Button, Card, DangerRow, Field, Notice, Row, Section, type ActionResult } from './kit'

export const ROWS = defineRows('library', {
  packs: { label: 'Your packs', help: 'Reference documents the model reads before it answers — installed packs and folders of your own files. Passages are retrieved by relevance and handed to the model with their source. The reference_lookup tool under Tools is how the model reaches it.', keywords: ['packs', 'folder', 'zim', 'reference', 'almanac'] },
  curated: { label: 'Curated packs', help: 'Reference packs bundled with this build — first aid, health, preparedness, food safety, finance, home safety, civics. Installing copies them into your library and uses no network.', keywords: ['bundled', 'first aid', 'health'] },
  lookup: { label: 'Try a lookup', help: 'See what the model would be given for a question. This is the same retrieval the reference_lookup tool runs.', keywords: ['test', 'search', 'passages'] }
})
registerRows(ROWS)

function kb(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} M chars`
  if (chars >= 10_000) return `${Math.round(chars / 1000)} K chars`
  return `${chars.toLocaleString()} chars`
}

export function LibraryTab(): JSX.Element {
  const [packs, setPacks] = useState<LibraryPackSummary[] | null>(null)
  const [bundled, setBundled] = useState<LibraryBundledPack[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<ActionResult | null>(null)
  const [embedding, setEmbedding] = useState<{ packId: string; done: number; total: number } | null>(null)
  const [freshness, setFreshness] = useState<Record<string, LibraryFreshness>>({})
  const [query, setQuery] = useState('')
  const [lookup, setLookup] = useState<LibraryLookupResult | null>(null)
  const [looking, setLooking] = useState(false)
  const mounted = useRef(true)

  const refresh = useCallback(() => {
    void window.api.libraryBundled().then((b) => { if (mounted.current) setBundled(b) }).catch(() => {})
    void window.api
      .libraryList()
      .then(async (list) => {
        if (!mounted.current) return
        setPacks(list)
        const reports: Record<string, LibraryFreshness> = {}
        for (const p of list) {
          if (p.kind !== 'user' || !p.sourceFolder) continue
          try {
            reports[p.id] = await window.api.libraryCheckFresh(p.id)
          } catch {
            // an unreadable folder shows nothing rather than a false alarm
          }
        }
        if (mounted.current) setFreshness(reports)
      })
      .catch(() => setPacks([]))
  }, [])

  useEffect(() => {
    mounted.current = true
    refresh()
    const off = window.api.onLibraryEmbedProgress((p) => setEmbedding(p))
    return () => {
      mounted.current = false
      off()
    }
  }, [refresh])

  const ok = (text: string): void => setNotice({ tone: 'ok', text })
  const fail = (text: string): void => setNotice({ tone: 'danger', text })

  const embed = async (pack: LibraryPackSummary, opts: { auto?: boolean } = {}): Promise<void> => {
    setBusy(`embed:${pack.id}`)
    if (!opts.auto) setNotice(null)
    setEmbedding({ packId: pack.id, done: pack.embeddedChunks, total: pack.chunks })
    try {
      const r = await window.api.libraryEmbed(pack.id)
      if (r.ok) ok(`Embedded “${pack.name}”: ${r.embedded} of ${r.total} passages with ${r.model}.`)
      else if (opts.auto && (r.error ?? '').includes('No embedding model')) setNotice({ tone: 'info', text: `“${pack.name}” is ready with keyword search. Load an embedding model in LM Studio and press Embed to add semantic search.` })
      else fail(`Embedding “${pack.name}” stopped: ${r.error ?? 'unknown error'} (${r.embedded} of ${r.total} kept).`)
    } finally {
      setEmbedding(null)
      setBusy(null)
      refresh()
    }
  }

  const addFolder = async (): Promise<void> => {
    setBusy('add')
    setNotice(null)
    try {
      const r = await window.api.libraryAddFolder()
      if (r.cancelled) return
      if (!r.ok || !r.pack) return fail(r.error ?? 'Adding the folder failed.')
      ok(`Added “${r.pack.name}” — ${r.pack.docs} document(s), ${r.pack.chunks} passage(s).`)
      refresh()
      if (r.pack.chunks > r.pack.embeddedChunks) await embed(r.pack, { auto: true })
    } finally {
      setBusy(null)
    }
  }

  const addZim = async (): Promise<void> => {
    setBusy('add')
    setNotice(null)
    try {
      const r = await window.api.libraryAddZim()
      if (r.cancelled) return
      if (!r.ok || !r.pack) return fail(r.error ?? 'Adding the ZIM file failed.')
      ok(`Added “${r.pack.name}” — ${r.pack.docs.toLocaleString()} entries, read on demand from the file where it is.`)
      refresh()
    } finally {
      setBusy(null)
    }
  }

  const installDirectory = async (): Promise<void> => {
    setBusy('add')
    setNotice(null)
    try {
      const r = await window.api.libraryInstallFromDirectory()
      if (r.cancelled) return
      if (!r.ok) return fail(r.error ?? 'Installing the pack failed.')
      if (r.pack) ok(`Installed pack “${r.pack.name}” — ${r.pack.docs} document(s), ${r.pack.chunks} passage(s).`)
      refresh()
    } finally {
      setBusy(null)
    }
  }

  const installBundled = async (b: LibraryBundledPack): Promise<void> => {
    setBusy(`bundled:${b.id}`)
    setNotice(null)
    try {
      const r = await window.api.libraryInstallBundled(b.id)
      if (!r.ok || !r.pack) return fail(r.error ?? `Installing “${b.name}” failed.`)
      ok(`Installed “${r.pack.name}” — ${r.pack.docs} document(s), ${r.pack.chunks} passage(s).`)
      refresh()
      if (r.pack.chunks > r.pack.embeddedChunks) await embed(r.pack, { auto: true })
    } finally {
      setBusy(null)
    }
  }

  const update = async (pack: LibraryPackSummary): Promise<void> => {
    setBusy(`update:${pack.id}`)
    setNotice(null)
    try {
      const r = await window.api.libraryUpdateFromFolder(pack.id)
      if (!r.ok || !r.pack) return fail(r.error ?? `Updating “${pack.name}” failed.`)
      const carried = r.carriedChunks ?? 0
      const missing = r.missingChunks ?? 0
      ok(`Updated “${r.pack.name}”: ${r.pack.docs} document(s) · ${carried} passage(s) kept their embeddings${missing > 0 ? `, ${missing} to embed.` : '.'}`)
      refresh()
      if (missing > 0) await embed(r.pack, { auto: true })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (pack: LibraryPackSummary): Promise<void> => {
    const r = await window.api.libraryRemove(pack.id)
    if (r.removed) ok(`Removed “${pack.name}”. Its copied documents are deleted; the original files are untouched.`)
    else fail('That pack was not found.')
    refresh()
  }

  const tryLookup = async (): Promise<void> => {
    if (!query.trim()) return
    setLooking(true)
    try {
      setLookup(await window.api.libraryLookup(query, null, 4))
    } finally {
      setLooking(false)
    }
  }

  const totalDocs = packs?.reduce((n, p) => n + p.docs, 0) ?? 0
  const totalChunks = packs?.reduce((n, p) => n + p.chunks, 0) ?? 0
  const totalEmbedded = packs?.reduce((n, p) => n + p.embeddedChunks, 0) ?? 0

  return (
    <div className="space-y-8">
      <Section
        title="Your packs"
        description={ROWS.packs.help}
        right={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Button disabled={busy !== null} onClick={() => void addFolder()} title="Build a pack from a folder of .md, .txt, .pdf and .docx files, then embed it. The folder is remembered: when it changes, the pack shows it and updates in place.">
              Add folder…
            </Button>
            <Button disabled={busy !== null} onClick={() => void addZim()} title="Register a Kiwix ZIM file — offline Wikipedia, WikiMed, the rest of the Kiwix catalogue — as a pack. The file stays where it is; no network.">
              Add ZIM file…
            </Button>
            <Button disabled={busy !== null} onClick={() => void installDirectory()} title="Install a downloaded reference pack (a folder containing manifest.json and docs/)">
              Install pack…
            </Button>
            <Button onClick={refresh}>Refresh</Button>
          </span>
        }
      >
        <Row
          meta={ROWS.packs}
          bare
          foot={
            packs && packs.length > 0 ? (
              <span className="text-xs text-ink-tertiary">
                {packs.length} pack{packs.length === 1 ? '' : 's'} · {totalDocs} documents · {totalChunks} passages · {totalEmbedded === totalChunks ? 'all embedded' : `${totalEmbedded} embedded`}. Stored under the app’s data folder; the original files you added are never modified.
              </span>
            ) : undefined
          }
        >
          <div className="space-y-2">
            {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
            {packs === null ? (
              <p className="text-xs text-ink-tertiary">Loading…</p>
            ) : packs.length === 0 ? (
              <Notice tone="muted">No packs installed yet. Install the curated packs below with one click, or add a folder of your own documents. Packs are plain folders — docs/library-pack-format.md describes the format.</Notice>
            ) : (
              packs.map((p) => {
                const progress = embedding && embedding.packId === p.id ? embedding : null
                const fully = p.chunks > 0 && p.embeddedChunks === p.chunks
                const fresh = p.kind === 'user' && p.sourceFolder ? freshness[p.id] : undefined
                const drift = fresh && !fresh.fresh ? fresh : undefined
                const driftLine = drift
                  ? drift.missingFolder
                    ? 'The source folder no longer exists — lookups keep working from the copy.'
                    : `Source folder has changed: ${[drift.changed ? `${drift.changed} edited` : '', drift.added ? `${drift.added} new` : '', drift.removed ? `${drift.removed} removed` : ''].filter(Boolean).join(', ')}${drift.examples.length ? ` (${drift.examples.join(', ')}${drift.added + drift.changed + drift.removed > drift.examples.length ? ', …' : ''})` : ''}.`
                  : null
                const kind = p.kind === 'user' ? 'your documents' : p.kind === 'app' ? 'written by this app — claims it verified, with dates' : p.kind === 'zim' ? 'a ZIM file, read on demand — offline wiki' : 'reference pack'
                return (
                  <Card
                    key={p.id}
                    title={p.name}
                    status={`${kind}${p.kind === 'app' ? '' : ` · v${p.version}`}`}
                    right={
                      <>
                        {p.kind === 'user' && p.sourceFolder && !drift?.missingFolder && !progress && (
                          <Button disabled={busy !== null} onClick={() => void update(p)} className={drift ? 'border-amber-500/40 text-ink-warn' : ''} title="Re-read the folder this pack was built from. Documents whose text is unchanged keep their embeddings; only new and edited ones are re-embedded.">
                            Update
                          </Button>
                        )}
                        {progress ? (
                          <Button onClick={() => void window.api.libraryCancelEmbed()}>Cancel</Button>
                        ) : p.kind === 'app' || p.kind === 'zim' ? null : (
                          <Button disabled={busy !== null || fully} onClick={() => void embed(p)} title="Compute embedding vectors with the loaded embedding model so lookups can match meaning, not just words. Stored per model; re-run after changing the embedding model.">
                            {fully ? 'Embedded' : p.embeddedChunks > 0 ? 'Finish embedding' : 'Embed'}
                          </Button>
                        )}
                        <DangerRow variant="inline" label="" action="Remove" confirm={`Remove “${p.name}”?`} disabled={busy !== null} onConfirm={() => remove(p)} />
                      </>
                    }
                  >
                    {p.description && <p className="text-xs text-ink-secondary">{p.description}</p>}
                    <p className="mt-1 text-xs text-ink-tertiary">
                      {p.docs} document{p.docs === 1 ? '' : 's'} · {p.chunks} passages · {kb(p.chars)} · {p.license} ·{' '}
                      {progress ? `embedding ${progress.done}/${progress.total}…` : fully ? `embedded (${p.embeddingModel})` : p.embeddedChunks > 0 ? `${p.embeddedChunks}/${p.chunks} embedded — keyword + partial semantic` : 'keyword search only — embed for semantic search'}
                    </p>
                    {p.sourceNote && <p className="mt-1 break-all text-xs text-ink-tertiary">{p.sourceNote}</p>}
                    {driftLine && (
                      <p className="mt-1 text-xs text-ink-warn">
                        {driftLine}
                        {!drift?.missingFolder && ' Update to bring the pack up to date — unchanged documents keep their embeddings.'}
                      </p>
                    )}
                    {progress && (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-black/10 dark:bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                        <div className="h-full bg-accent transition-all" style={{ width: `${progress.total ? Math.round((100 * progress.done) / progress.total) : 0}%` }} />
                      </div>
                    )}
                  </Card>
                )
              })
            )}
          </div>
        </Row>
      </Section>

      {bundled.length > 0 && (
        <Section title="Curated packs" description={ROWS.curated.help}>
          <Row meta={ROWS.curated} bare>
            {bundled.every((b) => b.installed && b.installedVersion === b.version) ? (
              <Notice tone="ok">All {bundled.length} curated packs are installed and current.</Notice>
            ) : (
              <div className="space-y-1.5">
                {bundled.map((b) => {
                  const updatable = b.installed && b.installedVersion !== b.version
                  return (
                    <div key={b.id} data-list-row className="flex items-center gap-3 rounded-lg border border-black/10 px-3 py-2 text-xs dark:border-white/10">
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-ink-primary">{b.name}</span>{' '}
                        <span className="text-ink-tertiary">
                          · {b.docs} document{b.docs === 1 ? '' : 's'} · v{b.version} · {b.license}
                        </span>
                        {b.description && <p className="mt-0.5 text-ink-secondary">{b.description}</p>}
                      </div>
                      {b.installed && !updatable ? (
                        <span className="shrink-0 text-ink-ok">✓ installed</span>
                      ) : (
                        <Button disabled={busy !== null} onClick={() => void installBundled(b)} title={updatable ? `Installed v${b.installedVersion}; this build ships v${b.version}.` : 'Copy this pack into your library and embed it.'}>
                          {updatable ? `Update to v${b.version}` : 'Install'}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Row>
        </Section>
      )}

      <Section title="Try a lookup" description={ROWS.lookup.help}>
        <Row meta={ROWS.lookup} layout="stack">
          <div className="space-y-3">
            <div className="flex gap-2">
              <Field value={query} onChange={setQuery} onCommit={(q) => { setQuery(q); void tryLookup() }} placeholder="e.g. how long to cool a burn under running water" label="Lookup query" />
              <ActionRow action="Look up" busy={looking ? 'Looking…' : null} disabled={!query.trim()} onAction={() => void tryLookup()} />
            </div>
            {lookup && (
              <div className="space-y-2">
                {!lookup.ok && <Notice tone="warn">{lookup.error}</Notice>}
                {lookup.ok && lookup.passages.length === 0 && <Notice tone="muted">No passages matched.</Notice>}
                {lookup.passages.map((p, i) => (
                  <Card key={i}>
                    <div className="text-xs font-medium text-ink-secondary">
                      [{i + 1}] {p.packName} › {p.docTitle}
                      {p.section ? ` › ${p.section}` : ''} · {Math.round(p.position * 100)}% in · relevance {p.score}
                    </div>
                    {(p.source || p.date || p.license) && <div className="mt-0.5 break-all text-xs text-ink-tertiary">{[p.source, p.date, p.license].filter(Boolean).join(' · ')}</div>}
                    <p className="mt-1 whitespace-pre-wrap text-xs text-ink-secondary">{p.text}</p>
                  </Card>
                ))}
                {lookup.notes.length > 0 && (
                  <p className="text-xs text-ink-tertiary">
                    {lookup.mode === 'hybrid' ? 'Semantic + keyword ranking. ' : 'Keyword ranking. '}
                    {lookup.notes.join(' ')}
                  </p>
                )}
              </div>
            )}
          </div>
        </Row>
      </Section>
    </div>
  )
}
