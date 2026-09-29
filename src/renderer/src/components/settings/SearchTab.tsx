// Settings → Search & research (v4.0, S4): the provider as cards, then Search
// and Deep research as two sections instead of one grid that paired a slider
// with a select. The Brave key stays in the keychain; the test tests what is
// in force, and saves nothing on the side.
import { useEffect, useState } from 'react'
import type { AppSettings } from '../../types'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { ActionRow, Button, DangerRow, Field, Notice, Row, Section, Segmented, Select, Slider, Switch, type ActionResult } from './kit'

export const ROWS = defineRows('search', {
  provider: { label: 'Search provider', help: 'Web search is the only feature that sends your words off this machine — only the query, only to the provider you choose, only when the web tools are enabled. Obvious personal data and secrets are redacted first, and every request appears under Activity.', keywords: ['searxng', 'brave', 'duckduckgo', 'engine'] },
  searxngUrl: { label: 'SearXNG instance', help: 'Run one with docker run -p 8888:8080 searxng/searxng and enable JSON output (formats: [html, json]). A loopback instance means only infrastructure you control ever sees your queries.', keywords: ['searxng', 'url', 'docker'] },
  braveKey: { label: 'Brave Search API key', help: 'Stored in your OS keychain — never in the settings file the window can read back. Get a free key at brave.com/search/api.', keywords: ['brave', 'api key', 'keychain'] },
  maxResults: { label: 'Results per search', help: 'How many results are handed to the model per query.', keywords: ['results', 'count'] },
  confirmBeforeSearch: { label: 'Confirm every query', help: 'Show the exact outgoing query for approval before each search.', keywords: ['approve', 'confirm'] },
  useHeadlessRenderer: { label: 'Read JavaScript-dependent pages', help: 'When a page returns no readable text (documentation sites, single-page apps), re-read it in an offscreen browser. Only the page’s own origin is contacted, every third-party request is blocked and logged, and the session keeps no cookies, cache or storage. Off by default, because unlike a plain fetch this runs the page’s scripts.', keywords: ['headless', 'renderer', 'browser', 'spa'] },
  depth: { label: 'Deep research budget', help: 'A hard ceiling on what one deep_research call may spend. The distinct-domain cap is the privacy-relevant one — it limits how many separate sites learn anything at all.', keywords: ['deep research', 'budget', 'quick', 'thorough'] },
  confirmPlan: { label: 'Approve research plans', help: 'Before a deep research run sends anything, show every sub-question and every outgoing query for approval — one dialog for the whole plan.', keywords: ['plan', 'approve'] },
  test: { label: 'Test the provider', help: 'One query to the provider in force, and what came back.', keywords: ['test connection'] }
})
registerRows(ROWS)

const PROVIDERS = [
  { value: 'searxng', label: 'Self-hosted SearXNG', hint: 'Most private: metasearch over 70+ engines from a server you run. No keys, no tracking.' },
  { value: 'brave', label: 'Brave Search API', hint: 'Independent index, no user profiling. Requires a free API key.' },
  { value: 'duckduckgo', label: 'DuckDuckGo', hint: 'No key needed, no tracking. Rate-limited; best for light use.' }
] as const

export interface SearchTabProps {
  settings: AppSettings
  apply: ApplySettings
  defaults: AppSettings | null
}

export function SearchTab({ settings, apply, defaults }: SearchTabProps): JSX.Element {
  const search = settings.search
  const research = settings.research
  const setSearch = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['search']>, shown?: string): void => apply(meta, { search: { ...search, ...patch } }, shown)
  const setResearch = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['research']>, shown?: string): void => apply(meta, { research: { ...research, ...patch } }, shown)

  const [keyInfo, setKeyInfo] = useState<{ set: boolean; encrypted: boolean } | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [keyNotice, setKeyNotice] = useState<ActionResult | null>(null)
  const [test, setTest] = useState<ActionResult | null>(null)
  const [testing, setTesting] = useState(false)
  useEffect(() => {
    void window.api.braveKeyStatus().then(setKeyInfo)
  }, [])

  return (
    <div className="space-y-8">
      <Section title="Search" description="Where a web search goes." onReset={defaults ? () => apply({ id: 'search.reset', label: 'Search' }, { search: defaults.search }, 'defaults') : undefined}>
        <Row meta={ROWS.provider} layout="stack">
          <Segmented variant="cards" value={search.provider} onChange={(provider) => setSearch(ROWS.provider, { provider }, PROVIDERS.find((p) => p.value === provider)?.label)} options={[...PROVIDERS]} />
        </Row>
        {search.provider === 'searxng' && (
          <Row meta={ROWS.searxngUrl} layout="stack">
            <Field value={search.searxngUrl} mono placeholder="http://127.0.0.1:8888" onCommit={(searxngUrl) => setSearch(ROWS.searxngUrl, { searxngUrl })} />
          </Row>
        )}
        {search.provider === 'brave' && (
          <Row meta={ROWS.braveKey} layout="stack" foot={keyNotice ? <Notice tone={keyNotice.tone}>{keyNotice.text}</Notice> : undefined}>
            <div className="flex flex-wrap gap-2">
              <div className="min-w-0 flex-1">
                <Field
                  type="password"
                  value={keyInput}
                  onChange={setKeyInput}
                  onCommit={setKeyInput}
                  label="Brave Search API key"
                  placeholder={keyInfo?.set ? `Key saved${keyInfo.encrypted ? ' (OS-keychain encrypted)' : ''} — enter a new one to replace` : 'Paste a key'}
                />
              </div>
              <Button
                disabled={!keyInput.trim()}
                onClick={() =>
                  void window.api.setBraveApiKey(keyInput).then((res) => {
                    setKeyInput('')
                    setKeyNotice(res.warning ? { tone: 'warn', text: res.warning } : res.ok ? { tone: 'ok', text: 'API key saved.' } : { tone: 'danger', text: 'Failed.' })
                    void window.api.braveKeyStatus().then(setKeyInfo)
                  })
                }
              >
                Save key
              </Button>
              {keyInfo?.set && (
                <DangerRow
                  variant="inline"
                  label=""
                  action="Remove"
                  confirm="Remove the key?"
                  onConfirm={() =>
                    window.api.setBraveApiKey('').then(() => {
                      setKeyNotice({ tone: 'ok', text: 'API key removed.' })
                      void window.api.braveKeyStatus().then(setKeyInfo)
                    })
                  }
                />
              )}
            </div>
          </Row>
        )}
        <Row meta={ROWS.maxResults}>
          <Slider value={search.maxResults} min={1} max={10} onCommit={(maxResults) => setSearch(ROWS.maxResults, { maxResults })} />
        </Row>
        <Row meta={ROWS.confirmBeforeSearch}>
          <Switch checked={search.confirmBeforeSearch} onChange={(confirmBeforeSearch) => setSearch(ROWS.confirmBeforeSearch, { confirmBeforeSearch })} />
        </Row>
        <Row meta={ROWS.useHeadlessRenderer}>
          <Switch checked={search.useHeadlessRenderer} onChange={(useHeadlessRenderer) => setSearch(ROWS.useHeadlessRenderer, { useHeadlessRenderer })} />
        </Row>
        <Row meta={ROWS.test} layout="stack">
          <ActionRow
            action="Test connection"
            busy={testing ? 'Testing…' : null}
            result={test}
            onAction={() => {
              setTesting(true)
              setTest(null)
              void window.api
                .testSearchProvider()
                .then((r) => setTest({ tone: r.ok ? 'ok' : 'danger', text: r.detail }))
                .finally(() => setTesting(false))
            }}
          />
        </Row>
      </Section>

      <Section title="Deep research" description="A cited, multi-step research run — planned, searched, read, and reported with its sources." onReset={defaults ? () => apply({ id: 'research.reset', label: 'Deep research' }, { research: defaults.research }, 'defaults') : undefined}>
        <Row meta={ROWS.depth}>
          <Select
            value={research.depth}
            onChange={(v) => setResearch(ROWS.depth, { depth: v as AppSettings['research']['depth'] })}
            options={[
              { value: 'quick', label: 'Quick — up to 3 searches, 4 pages, 4 domains' },
              { value: 'standard', label: 'Standard — up to 6 searches, 10 pages, 8 domains' },
              { value: 'thorough', label: 'Thorough — up to 10 searches, 16 pages, 12 domains' }
            ]}
          />
        </Row>
        <Row meta={ROWS.confirmPlan}>
          <Switch checked={research.confirmPlan} onChange={(confirmPlan) => setResearch(ROWS.confirmPlan, { confirmPlan })} />
        </Row>
      </Section>
    </div>
  )
}
