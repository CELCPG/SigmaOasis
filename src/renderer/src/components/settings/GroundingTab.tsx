// Settings → Grounding & checks (v4.0, S4): the seven grounding toggles,
// second opinion and claim checking, grouped by when they act — before the
// reply, after it, across replies — instead of under a heading called
// "Second opinion" at the foot of Models.
import type { AppSettings } from '../../types'
import type { ApplySettings } from '../../hooks/settingsApply'
import { defineRows, registerRows } from '../../lib/settingsKit'
import { Row, Section, Select, Stepper, Switch } from './kit'

export const ROWS = defineRows('grounding', {
  playbooks: { label: 'Playbooks', help: 'For first-aid, health, finance, legal, home-repair, data, code, comparison and planning questions, a short numbered method rides along with the turn — “say to call emergency services first”, “compute with the calculator, never in your head”. A few dozen tokens; the reply says which playbook was used. How a small model acts like it has expertise it does not have.', keywords: ['method', 'expertise'] },
  outline: { label: 'Outline long documents first', help: 'A request shaped like a document — an explicit length of 800 words or more, or a named form with its sections listed — is written from a JSON outline, one section at a time, so a small model writes the document it promised instead of drifting. No tools ride the sections. Disclosed under the reply. Off by default: the longform suite in docs/evals.md says what it measured.', keywords: ['longform', 'document', 'outline'] },
  libraryRerank: { label: 'Re-rank library passages', help: 'For health, first-aid, finance and building questions, the answering model reads the reference library’s top passages (up to 15, 600 characters each) and says which actually answer the question; those lead and the rest are dropped, so a passage that shares the question’s words but answers a different one stops being quoted. One extra call per such lookup, thinking off, abandoned after 4 seconds — the usual order stands then. Off by default: it adds that wait before the reply starts.', keywords: ['library', 'rerank', 'passages', 'reference'] },
  autoCorrect: { label: 'Correct unsupported specifics', help: 'When the grounding check finds an address, price, link or phone number the turn’s own tools never returned, the findings go back to the model for one revision — verify it with a tool, or drop it and say so. One extra round, only on answers already known to contain unsupported specifics; the reply is marked as revised.', keywords: ['revise', 'unsupported', 'grounding'] },
  sourceCheck: { label: 'Check sourced answers against their sources', help: 'When a reply was written from this turn’s search results, pages or library passages, the answering model re-reads each of its checkable sentences — a number, a score, a time, a date, a name; six at most — against the sources that bear on it, one at a time, thinking off. A sentence the sources contradict, or one citing a source that does not state it, goes back for the one revision. Up to six short extra calls per sourced reply, inside the checking limit; off by default until measured.', keywords: ['sources', 'claims', 'verify', 'citations'] },
  selfReview: { label: 'Think harder may review its own draft', help: '🧠 Think harder is draft → review → revise, once. With two roles the review comes from a different model. With one, this lets the same model read its own draft as a strict reviewer — weaker, always labelled “reviewed its own draft”, still useful for arithmetic slips and skipped steps. Off means think harder needs a second role.', keywords: ['think harder', 'self review'] },
  workbenchChecks: { label: 'Workbench checks', help: 'When a reply states figures that nothing computed, the model is asked for a short Python program that recomputes them and the app runs it in the sandbox; the reply is checked against that output like any calculator result. When a reply contains self-contained Python, the app runs it — a syntax error, an undefined name or a failed assertion is sent back for one revision. Both disclosed under the reply.', keywords: ['recompute', 'python', 'verify'] },
  secondOpinion: { label: 'Second opinions', help: 'Adds a 🔍 2nd opinion action under replies: a different role reviews the answer and names the factual claims it could not verify, plus the check that would settle each. Never a confidence score — a model grading its own answer says “yes” nearly always, so the reviewer is always another role. When on, the review also runs automatically on factual-looking answers that consulted no web source.', keywords: ['critic', 'review', 'reviewer'] },
  criticSlotId: { label: 'Reviewing role', help: 'Needs at least two enabled roles; with one, the action explains that no independent review is possible instead of asking the answerer to grade itself.', keywords: ['critic', 'reviewer'] },
  claimCheck: { label: 'Check claims automatically', help: 'On ⚠️ unverified answers, the reviewing role extracts the factual claims and the app checks each against web sources — confirmed, contradicted or unverifiable, with the source shown. One search per claim, respecting “confirm every query”.', keywords: ['claims', 'verify', 'sources'] },
  maxClaims: { label: 'Claims checked per reply', help: 'Keeps the pass cheap: one search each.', keywords: ['claims', 'limit'] },
  ledger: { label: 'Conversation ledger', help: 'From the fourth turn on, the model is handed a mechanical record of what this conversation has established: figures a tool computed, files attached, Python session variables, and constraints you stated — exact strings from tool results and your own words, never from earlier replies, so a small model refers back instead of re-remembering. Disclosed under the reply.', keywords: ['ledger', 'established', 'record'] },
  factLedger: { label: 'Fact ledger', help: 'A price, a measurement, an address, a contact, a URL or a date the reply states and a retrieved source states too is kept, with the source and the date it was checked, in a library pack the app writes. The next factual ask consults it before the app-run search; an expired entry is re-checked and a changed value is disclosed. Nothing but the app writes it.', keywords: ['facts', 'verification', 'compounds'] }
})
registerRows(ROWS)

export interface GroundingTabProps {
  settings: AppSettings
  apply: ApplySettings
  defaults: AppSettings | null
}

export function GroundingTab({ settings, apply, defaults }: GroundingTabProps): JSX.Element {
  const g = settings.grounding
  const setG = (meta: (typeof ROWS)[keyof typeof ROWS], patch: Partial<AppSettings['grounding']>): void => apply(meta, { grounding: { ...g, ...patch } })
  const reset = (label: string, keys: (keyof AppSettings['grounding'])[], extra: Partial<AppSettings> = {}): (() => void) | undefined =>
    defaults ? () => apply({ id: 'grounding.reset', label }, { grounding: { ...g, ...Object.fromEntries(keys.map((k) => [k, defaults.grounding[k]])) }, ...extra }, 'defaults') : undefined
  const enabledRoles = settings.models.filter((m) => m.enabled)
  return (
    <div className="space-y-8">
      <Section title="Before the reply" description="What rides the turn with the question." onReset={reset('Before the reply', ['playbooks', 'outline', 'libraryRerank'])}>
        <Row meta={ROWS.playbooks}>
          <Switch checked={g.playbooks} onChange={(playbooks) => setG(ROWS.playbooks, { playbooks })} />
        </Row>
        <Row meta={ROWS.outline}>
          <Switch checked={g.outline} onChange={(outline) => setG(ROWS.outline, { outline })} />
        </Row>
        <Row meta={ROWS.libraryRerank}>
          <Switch checked={g.libraryRerank === true} onChange={(libraryRerank) => setG(ROWS.libraryRerank, { libraryRerank })} />
        </Row>
      </Section>

      <Section
        title="After the reply"
        description="Checks that read the answer and can send it back for one revision."
        onReset={reset('After the reply', ['autoCorrect', 'selfReview', 'workbenchChecks', 'sourceCheck'], defaults ? { secondOpinion: defaults.secondOpinion, claimCheck: defaults.claimCheck } : {})}
      >
        <Row meta={ROWS.autoCorrect}>
          <Switch checked={g.autoCorrect} onChange={(autoCorrect) => setG(ROWS.autoCorrect, { autoCorrect })} />
        </Row>
        <Row meta={ROWS.workbenchChecks}>
          <Switch checked={g.workbenchChecks} onChange={(workbenchChecks) => setG(ROWS.workbenchChecks, { workbenchChecks })} />
        </Row>
        <Row meta={ROWS.sourceCheck}>
          <Switch checked={g.sourceCheck === true} onChange={(sourceCheck) => setG(ROWS.sourceCheck, { sourceCheck })} />
        </Row>
        <Row meta={ROWS.selfReview}>
          <Switch checked={g.selfReview} onChange={(selfReview) => setG(ROWS.selfReview, { selfReview })} />
        </Row>
        <Row meta={ROWS.secondOpinion}>
          <Switch checked={settings.secondOpinion.enabled} onChange={(enabled) => apply(ROWS.secondOpinion, { secondOpinion: { ...settings.secondOpinion, enabled } })} />
        </Row>
        {settings.secondOpinion.enabled && (
          <>
            <Row meta={ROWS.criticSlotId}>
              <Select
                value={settings.secondOpinion.criticSlotId ?? ''}
                onChange={(v) => apply(ROWS.criticSlotId, { secondOpinion: { ...settings.secondOpinion, criticSlotId: v || null } }, v ? enabledRoles.find((m) => m.id === v)?.roleName : 'Auto')}
                options={[{ value: '', label: 'Auto — first enabled role that did not answer' }, ...enabledRoles.map((m) => ({ value: m.id, label: m.roleName || m.id }))]}
              />
            </Row>
            <Row meta={ROWS.claimCheck}>
              <Switch checked={settings.claimCheck.enabled} onChange={(enabled) => apply(ROWS.claimCheck, { claimCheck: { ...settings.claimCheck, enabled } })} />
            </Row>
            {settings.claimCheck.enabled && (
              <Row meta={ROWS.maxClaims}>
                <Stepper value={settings.claimCheck.maxClaims} min={1} max={10} onChange={(maxClaims) => apply(ROWS.maxClaims, { claimCheck: { ...settings.claimCheck, maxClaims } })} />
              </Row>
            )}
          </>
        )}
      </Section>

      <Section title="Across replies" description="What the app keeps from one turn, or one conversation, to the next." onReset={reset('Across replies', ['ledger', 'factLedger'])}>
        <Row meta={ROWS.ledger}>
          <Switch checked={g.ledger} onChange={(ledger) => setG(ROWS.ledger, { ledger })} />
        </Row>
        <Row meta={ROWS.factLedger}>
          <Switch checked={g.factLedger} onChange={(factLedger) => setG(ROWS.factLedger, { factLedger })} />
        </Row>
      </Section>
    </div>
  )
}
