import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryBundledPack, LibraryFreshness, LibraryLookupResult, LibraryPackSummary } from '../../types'

/**
 * Settings → Library (v1.5, the Almanac). Lists installed reference packs,
 * adds a folder of the user's own documents as a pack, installs a downloaded
 * pack directory, embeds a pack for semantic retrieval (with progress), removes
 * packs, and lets the user try a lookup and see exactly what the model would be
 * given. Everything on this tab is local: disk, plus loopback embeddings.
 *
 * First tab split out of SettingsModal.tsx (STRATEGY-speed-and-quality.md 2d):
 * the modal only mounts it; state lives here.
 */

const BUTTON =
  'rounded-lg border border-black/10 dark:border-white/10 px-3 py-1 text-xs hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40'
const NOTE = 'rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs text-neutral-500'
const WARN = 'rounded-lg bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400'

function kb(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} M chars`
  if (chars >= 10_000) return `${Math.round(chars / 1000)} K chars`
  return `${chars.toLocaleString()} chars`
}

export function LibraryTab(): JSX.Element {
  const [packs, setPacks] = useState<LibraryPackSummary[] | null>(null)
  const [bundled, setBundled] = useState<LibraryBundledPack[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
        // Staleness, per tracked user pack. stat-only in the main process, so
        // running it on every open keeps "your pack is out of date" ambient
        // rather than something the user has to think to ask for.
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

  const run = async (label: string, action: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean; pack?: LibraryPackSummary }>): Promise<void> => {
    setBusy(label)
    setNotice(null)
    try {
      const result = await action()
      if (result.cancelled) return
      if (!result.ok) setNotice(result.error ?? `${label} failed.`)
      else if (result.pack) setNotice(`${label}: "${result.pack.name}" — ${result.pack.docs} document(s), ${result.pack.chunks} passage(s).`)
      refresh()
    } finally {
      setBusy(null)
    }
  }

  const embed = async (pack: LibraryPackSummary, opts: { auto?: boolean } = {}): Promise<void> => {
    setBusy(`embed:${pack.id}`)
    if (!opts.auto) setNotice(null)
    setEmbedding({ packId: pack.id, done: pack.embeddedChunks, total: pack.chunks })
    try {
      const r = await window.api.libraryEmbed(pack.id)
      if (r.ok) {
        setNotice(`Embedded "${pack.name}": ${r.embedded} of ${r.total} passages with ${r.model}.`)
      } else if (opts.auto && (r.error ?? '').includes('No embedding model')) {
        // The automatic pass after add/update, with no embedding model loaded:
        // not an error — keyword retrieval already works.
        setNotice(
          `"${pack.name}" is ready with keyword search. Load an embedding model in LM Studio and press Embed to add semantic search.`
        )
      } else {
        setNotice(`Embedding "${pack.name}" stopped: ${r.error ?? 'unknown error'} (${r.embedded} of ${r.total} kept).`)
      }
    } finally {
      setEmbedding(null)
      setBusy(null)
      refresh()
    }
  }

  /** Add folder → pack, then embed it without being asked (progress is visible; cancel works). */
  const addFolder = async (): Promise<void> => {
    setBusy('add')
    setNotice(null)
    try {
      const r = await window.api.libraryAddFolder()
      if (r.cancelled) return
      if (!r.ok || !r.pack) {
        setNotice(r.error ?? 'Adding the folder failed.')
        return
      }
      setNotice(`Added "${r.pack.name}" — ${r.pack.docs} document(s), ${r.pack.chunks} passage(s).`)
      refresh()
      if (r.pack.chunks > r.pack.embeddedChunks) await embed(r.pack, { auto: true })
    } finally {
      setBusy(null)
    }
  }

  /** Install a curated pack shipped inside the app — disk to disk, then embed. */
  const installBundled = async (b: LibraryBundledPack): Promise<void> => {
    setBusy(`bundled:${b.id}`)
    setNotice(null)
    try {
      const r = await window.api.libraryInstallBundled(b.id)
      if (!r.ok || !r.pack) {
        setNotice(r.error ?? `Installing "${b.name}" failed.`)
        return
      }
      setNotice(`Installed "${r.pack.name}" — ${r.pack.docs} document(s), ${r.pack.chunks} passage(s).`)
      refresh()
      if (r.pack.chunks > r.pack.embeddedChunks) await embed(r.pack, { auto: true })
    } finally {
      setBusy(null)
    }
  }

  /** Re-read the tracked folder; unchanged documents keep their embeddings. */
  const update = async (pack: LibraryPackSummary): Promise<void> => {
    setBusy(`update:${pack.id}`)
    setNotice(null)
    try {
      const r = await window.api.libraryUpdateFromFolder(pack.id)
      if (!r.ok || !r.pack) {
        setNotice(r.error ?? `Updating "${pack.name}" failed.`)
        return
      }
      const carried = r.carriedChunks ?? 0
      const missing = r.missingChunks ?? 0
      setNotice(
        `Updated "${r.pack.name}": ${r.pack.docs} document(s) · ${carried} passage(s) kept their embeddings` +
          (missing > 0 ? `, ${missing} to embed.` : '.')
      )
      refresh()
      if (missing > 0) await embed(r.pack, { auto: true })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (pack: LibraryPackSummary): Promise<void> => {
    if (!window.confirm(`Remove "${pack.name}" from the reference library? Its copied documents are deleted; the original files are untouched.`)) return
    await run('Removed', async () => {
      const r = await window.api.libraryRemove(pack.id)
      return { ok: r.removed, error: r.removed ? undefined : 'That pack was not found.' }
    })
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
    <div className="space-y-5">
      <div>
        <div className="text-sm font-medium">Reference library</div>
        <p className="mt-1 text-xs text-neutral-500">
          Reference documents the model reads <em>before</em> it answers — installed reference packs
          and folders of your own files. Passages are retrieved by relevance and handed to the model
          with their source, so answers about first aid, finance, health or your own manuals quote a
          document instead of guessing. Entirely local: nothing on this tab uses the network. The{' '}
          <code>reference_lookup</code> tool (Settings → Tools) is how the model reaches it.
        </p>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void addFolder()}
          className={BUTTON}
          title="Build a pack from a folder of .md, .txt and .pdf files, then embed it. The folder is remembered: when it changes, the pack shows it and updates in place."
        >
          Add folder…
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run('Installed pack', () => window.api.libraryInstallFromDirectory())}
          className={BUTTON}
          title="Install a downloaded reference pack (a folder containing manifest.json and docs/)"
        >
          Install pack…
        </button>
        <button type="button" onClick={refresh} className={`${BUTTON} ml-auto`}>
          Refresh
        </button>
      </div>
      {notice && <p className={NOTE}>{notice}</p>}

      {/* Packs */}
      {packs === null ? (
        <p className={NOTE}>Loading…</p>
      ) : packs.length === 0 ? (
        <p className={NOTE}>
          No packs installed yet. Install the curated packs below with one click, or add a folder of
          your own documents. Packs are plain folders — <code>docs/library-pack-format.md</code> in
          the repository describes the format.
        </p>
      ) : (
        <ul className="space-y-2">
          {packs.map((p) => {
            const progress = embedding && embedding.packId === p.id ? embedding : null
            const fully = p.chunks > 0 && p.embeddedChunks === p.chunks
            const fresh = p.kind === 'user' && p.sourceFolder ? freshness[p.id] : undefined
            const drift = fresh && !fresh.fresh ? fresh : undefined
            const driftLine = drift
              ? drift.missingFolder
                ? 'The source folder no longer exists — lookups keep working from the copy.'
                : `Source folder has changed: ${[
                    drift.changed ? `${drift.changed} edited` : '',
                    drift.added ? `${drift.added} new` : '',
                    drift.removed ? `${drift.removed} removed` : ''
                  ]
                    .filter(Boolean)
                    .join(', ')}${drift.examples.length ? ` (${drift.examples.join(', ')}${drift.added + drift.changed + drift.removed > drift.examples.length ? ', …' : ''})` : ''}.`
              : null
            return (
              <li key={p.id} className="rounded-xl border border-black/10 dark:border-white/10 p-3 text-xs">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {p.name}{' '}
                      <span className="font-normal text-neutral-400">
                        · {p.kind === 'user' ? 'your documents' : 'reference pack'} · v{p.version}
                      </span>
                    </div>
                    {p.description && <p className="mt-0.5 text-neutral-500">{p.description}</p>}
                    <p className="mt-1 text-neutral-400">
                      {p.docs} document{p.docs === 1 ? '' : 's'} · {p.chunks} passages · {kb(p.chars)} · {p.license}
                      {' · '}
                      {progress
                        ? `embedding ${progress.done}/${progress.total}…`
                        : fully
                          ? `embedded (${p.embeddingModel})`
                          : p.embeddedChunks > 0
                            ? `${p.embeddedChunks}/${p.chunks} embedded — keyword + partial semantic`
                            : 'keyword search only — embed for semantic search'}
                    </p>
                    {p.sourceNote && <p className="mt-1 text-neutral-400 break-all">{p.sourceNote}</p>}
                    {driftLine && (
                      <p className="mt-1 text-amber-600 dark:text-amber-400">
                        {driftLine}
                        {!drift?.missingFolder && ' Update to bring the pack up to date — unchanged documents keep their embeddings.'}
                      </p>
                    )}
                    {progress && (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-black/10 dark:bg-white/10">
                        <div
                          className="h-full bg-accent transition-all"
                          style={{ width: `${progress.total ? Math.round((100 * progress.done) / progress.total) : 0}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    {p.kind === 'user' && p.sourceFolder && !drift?.missingFolder && !progress && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void update(p)}
                        className={drift ? `${BUTTON} border-amber-500/40 text-amber-600 dark:text-amber-400` : BUTTON}
                        title="Re-read the folder this pack was built from. Documents whose text is unchanged keep their embeddings; only new and edited ones are re-embedded."
                      >
                        Update
                      </button>
                    )}
                    {progress ? (
                      <button type="button" onClick={() => void window.api.libraryCancelEmbed()} className={BUTTON}>
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy !== null || fully}
                        onClick={() => void embed(p)}
                        className={BUTTON}
                        title="Compute embedding vectors with the loaded embedding model so lookups can match meaning, not just words. Stored per model; re-run after changing the embedding model."
                      >
                        {fully ? 'Embedded' : p.embeddedChunks > 0 ? 'Finish embedding' : 'Embed'}
                      </button>
                    )}
                    <button type="button" disabled={busy !== null} onClick={() => void remove(p)} className={`${BUTTON} text-red-500`}>
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {packs && packs.length > 0 && (
        <p className="text-xs text-neutral-400">
          {packs.length} pack{packs.length === 1 ? '' : 's'} · {totalDocs} documents · {totalChunks} passages ·{' '}
          {totalEmbedded === totalChunks ? 'all embedded' : `${totalEmbedded} embedded`}. Stored under the app&apos;s
          data folder; the original files you added are never modified.
        </p>
      )}

      {/* Curated packs shipped inside the app (v1.7.1) */}
      {bundled.length > 0 && (
        <div className="border-t border-black/10 dark:border-white/10 pt-4">
          <div className="text-sm font-medium">Curated packs</div>
          <p className="mt-1 text-xs text-neutral-500">
            Reference packs bundled with this build — first aid, health, preparedness, food safety,
            finance, home safety, civics. Installing copies them into your library and uses no
            network.
          </p>
          {bundled.every((b) => b.installed && b.installedVersion === b.version) ? (
            <p className={`${NOTE} mt-2`}>
              All {bundled.length} curated packs are installed and current.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {bundled.map((b) => {
                const updatable = b.installed && b.installedVersion !== b.version
                return (
                  <li key={b.id} className="flex items-center gap-2 rounded-xl border border-black/10 dark:border-white/10 p-2.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{b.name}</span>{' '}
                      <span className="text-neutral-400">
                        · {b.docs} document{b.docs === 1 ? '' : 's'} · v{b.version} · {b.license}
                      </span>
                      {b.description && <p className="mt-0.5 text-neutral-500">{b.description}</p>}
                    </div>
                    {b.installed && !updatable ? (
                      <span className="shrink-0 text-neutral-400">✓ installed</span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void installBundled(b)}
                        className={`${BUTTON} shrink-0`}
                        title={updatable ? `Installed v${b.installedVersion}; this build ships v${b.version}.` : 'Copy this pack into your library and embed it.'}
                      >
                        {updatable ? `Update to v${b.version}` : 'Install'}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {/* Try it */}
      <div className="border-t border-black/10 dark:border-white/10 pt-4">
        <div className="text-sm font-medium">Try a lookup</div>
        <p className="mt-1 text-xs text-neutral-500">
          See what the model would be given for a question. This is the same retrieval the{' '}
          <code>reference_lookup</code> tool runs.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void tryLookup()
            }}
            placeholder="e.g. how long to cool a burn under running water"
            className="flex-1 rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent/40"
          />
          <button type="button" disabled={looking || !query.trim()} onClick={() => void tryLookup()} className={BUTTON}>
            {looking ? 'Looking…' : 'Look up'}
          </button>
        </div>
        {lookup && (
          <div className="mt-3 space-y-2">
            {!lookup.ok && <p className={WARN}>{lookup.error}</p>}
            {lookup.ok && lookup.passages.length === 0 && <p className={NOTE}>No passages matched.</p>}
            {lookup.passages.map((p, i) => (
              <div key={i} className="rounded-xl border border-black/10 dark:border-white/10 p-2.5 text-xs">
                <div className="font-medium text-neutral-600 dark:text-neutral-300">
                  [{i + 1}] {p.packName} › {p.docTitle}
                  {p.section ? ` › ${p.section}` : ''} · {Math.round(p.position * 100)}% in · relevance {p.score}
                </div>
                {(p.source || p.date || p.license) && (
                  <div className="mt-0.5 break-all text-neutral-400">
                    {[p.source, p.date, p.license].filter(Boolean).join(' · ')}
                  </div>
                )}
                <p className="mt-1 whitespace-pre-wrap text-neutral-500">{p.text}</p>
              </div>
            ))}
            {lookup.notes.length > 0 && (
              <p className="text-xs text-neutral-400">
                {lookup.mode === 'hybrid' ? 'Semantic + keyword ranking. ' : 'Keyword ranking. '}
                {lookup.notes.join(' ')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
