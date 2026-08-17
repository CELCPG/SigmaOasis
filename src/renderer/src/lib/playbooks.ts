import { referenceDomains } from './grounding'
import { TABULAR_FILE } from './attachmentRecall'
import type { ReferenceDomain } from './grounding'

/**
 * v1.5 Playbooks: retrievable method for a 9–30B model.
 *
 * A small model's third weakness (STRATEGY-depth-and-reasoning.md, Part 0)
 * is procedure — it does not know how an expert *goes about* a first-aid
 * question, a tax question, a spreadsheet, a plan. The slot prompts carry a
 * persona; a playbook carries the method for one kind of question, and it is
 * chosen per turn rather than baked into a role. Each is short and imperative
 * (small models attend to brief numbered rules and tune out essays), and it
 * rides the same turn-notes slot as memory recall and library passages, so the
 * system prompt stays byte-stable between turns.
 *
 * Curated in code on purpose: they are part of the app's behaviour, reviewed
 * like code, versioned with the release, and disclosed under every reply that
 * used one ("📋 Method: First aid"). A pack-supplied playbook format is a
 * possible later step; the mechanism does not depend on where the text lives.
 *
 * One playbook per turn — the most consequential domain wins — because two
 * methods stacked read as two lists of rules, and a small model follows one.
 */

export type PlaybookId =
  | 'first-aid'
  | 'health'
  | 'building'
  | 'preparedness'
  | 'food'
  | 'home'
  | 'finance'
  | 'legal'
  | 'data-analysis'
  | 'coding'
  | 'compare'
  | 'planning'

export interface Playbook {
  id: PlaybookId
  /** Short label shown under the reply. */
  name: string
  /** The method, as the model sees it. Numbered, imperative, ≤ ~90 words. */
  steps: string[]
}

export const PLAYBOOKS: Record<PlaybookId, Playbook> = {
  'first-aid': {
    id: 'first-aid',
    name: 'First aid',
    steps: [
      'If anything suggests a life-threatening emergency — unresponsive, not breathing, severe bleeding, chest pain, stroke signs, anaphylaxis, a serious burn — say to call emergency services now, before anything else.',
      'Give the immediate steps in order, one per line. Quote reference passages when you have them; never paraphrase amounts, durations or dosages.',
      'Say what NOT to do when the reference says so.',
      'End with when to seek professional care. Do not diagnose.'
    ]
  },
  health: {
    id: 'health',
    name: 'Health & medication',
    steps: [
      'State only what the reference passages support; quote dosages, intervals and warnings exactly. Never give a dose from memory.',
      'Name the red flags that mean "see a clinician or call emergency services now".',
      'Ask for the one or two facts that change the answer — age, pregnancy, other medications, allergies — rather than assuming them.',
      'Say once, without lecturing, that this is not a substitute for a clinician.'
    ]
  },
  building: {
    id: 'building',
    name: 'Structural, electrical & gas',
    steps: [
      'Treat load-bearing, wiring and gas questions as safety questions: state the code or reference figure with its source, or say you do not have one. Never estimate a load, span or amperage.',
      'Say plainly when the job needs a licensed professional or a permit.',
      'Give the safe order of operations first — power off at the breaker, gas valve closed — before any step.'
    ]
  },
  preparedness: {
    id: 'preparedness',
    name: 'Emergencies & preparedness',
    steps: [
      'Lead with the single most protective action for the hazard — evacuate, shelter, shut off utilities — then the next steps in order.',
      'Quote official guidance from the reference passages for quantities and timings (water per person per day, when to leave).',
      'Separate before / during / after when the question spans them.',
      'Point to the local authority for anything location-specific you cannot verify.'
    ]
  },
  food: {
    id: 'food',
    name: 'Food safety & nutrition',
    steps: [
      'Answer with the specific figure the reference gives — temperature, hours, days — and its source; if there is none, say so instead of approximating.',
      'When in doubt about spoiled food, say to discard it: the cost of being wrong is not symmetric.',
      'Note the higher-risk groups (pregnancy, infants, elderly, immunocompromised) when they matter.'
    ]
  },
  home: {
    id: 'home',
    name: 'Home repair',
    steps: [
      'Start with safety and isolation — water shut-off, breaker off, gas off — before diagnosis.',
      'Diagnose, then fix: what to check first, what each finding means, then the repair steps.',
      'List tools and parts before the steps, not scattered through them.',
      'Name the point at which to stop and call a professional (gas, mains electrical, structural, sewage).'
    ]
  },
  finance: {
    id: 'finance',
    name: 'Personal finance & tax',
    steps: [
      'Compute with finance_calculator, never in your head, and state the assumptions (rate, term, filing status).',
      'Quote the rule from the reference passages — thresholds, limits, deadlines — with its source and tax year; these change annually, so say which year a figure is for.',
      'Separate what the rule is from what the user should do; give the trade-off, not a recommendation dressed as fact.',
      'Say when a professional (CPA, advisor) is warranted.'
    ]
  },
  legal: {
    id: 'legal',
    name: 'Legal & civic',
    steps: [
      'Say which jurisdiction the answer assumes and that rules vary by state or country; ask if it matters and you do not know.',
      'Quote the reference passages for rights, deadlines and procedures with their source. Never invent a statute, section or case name.',
      'Give the practical next step — document it, notify in writing, which office to contact.',
      'State once that this is general information, not legal advice.'
    ]
  },
  'data-analysis': {
    id: 'data-analysis',
    name: 'Data analysis',
    steps: [
      'Describe the data before analysing it: rows, columns, types, missing values, obvious anomalies.',
      'Turn the question into a specific computation and compute it exactly — with a tool when one is available. Do not eyeball totals, averages or percentages.',
      'Report each number with its unit, denominator and caveats (sample size, missing rows). A summed ' +
        'price or rate column is meaningless — weight or average it, and say which.',
      // v1.8.1: measured — with sessions on, a 9B still re-read the data file
      // on 6 of 10 follow-ups out of habit. The capability was there; the
      // habit was not. Said here because the playbook rides every data turn.
      'run_python keeps its variables between calls in this conversation. For a follow-up question, ' +
        'build on the dataframe you already loaded — check the "Session variables" list in the last ' +
        'result before reading a file again.',
      'Only then interpret; keep interpretation separate from measurement.'
    ]
  },
  coding: {
    id: 'coding',
    name: 'Code',
    steps: [
      'Restate the task as a precise contract: inputs, outputs, edge cases, and what "done" means.',
      'Read the relevant code before changing it (read_file); keep changes minimal and local; preserve the existing style.',
      'Show the change as code, then say exactly how to verify it — the command or test. If you cannot run it, say so.',
      'Name any assumption you had to make.'
    ]
  },
  compare: {
    id: 'compare',
    name: 'Comparing options',
    steps: [
      'Fix the criteria first — what matters to the user, in order — then assess each option against them.',
      'Every specific claim (price, spec, date) must come from a tool result or a reference passage; an unknown cell stays "unknown", never guessed.',
      'Recommend one option, and say the condition under which another would win.'
    ]
  },
  planning: {
    id: 'planning',
    name: 'Plans',
    steps: [
      'State the goal, the constraints and the deadline in one line each; ask about a missing one only if it changes the plan.',
      'Break the work into ordered steps, each with a clear done-condition; put dependencies before what depends on them.',
      'Mark the first step to take today.',
      'Keep the plan short enough to follow; detail belongs in the step that needs it.'
    ]
  }
}

// ---- selection --------------------------------------------------------------

const DOMAIN_TO_PLAYBOOK: Record<ReferenceDomain, PlaybookId | null> = {
  'first-aid': 'first-aid',
  health: 'health',
  building: 'building',
  preparedness: 'preparedness',
  food: 'food',
  home: 'home',
  finance: 'finance',
  legal: 'legal',
  'reference-ask': null // "what does the manual say" — the library answers; no method needed
}

const DATA_INTENT =
  /\b(?:csv|spreadsheet|dataset|data ?set|pivot|correlat(?:e|ion)|regression|median|average of|mean of|sum of|group(?:ed)? by|per (?:month|week|day|region|category)|trend|outliers?|analy[sz]e (?:this|the|my|these) (?:data|numbers|table|rows|results|figures))\b/i
const CODE_SIGNAL =
  /```|Traceback \(most recent call last\)|^\s+at .+\(.+:\d+:\d+\)|\w+Error:|\b(?:refactor|debug|stack trace|unit tests?|compile(?:r|s)? error|type ?error|null pointer|segfault|pull request|function that|write (?:a|the|me a) (?:function|script|class|regex|query|test))\b/im
const COMPARE_INTENT =
  /\b(?:compare|comparison|versus|vs\.?|which is better|better than|pros and cons|trade-?offs?|should i (?:pick|choose|go with|buy)|difference between)\b/i
const PLAN_INTENT =
  /\b(?:plan (?:a|my|the|our|for)|make (?:a|me a) plan|itinerary|roadmap|schedule (?:for|out|my)|step[- ]by[- ]step plan|checklist for|how (?:should|do) i (?:organi[sz]e|structure|approach|prepare for))\b/i

/**
 * Is this data work? A tabular attachment says so outright — that file cannot
 * be read by eye and needs the Workbench — and otherwise the vocabulary has to
 * carry it. Shared with the pre-flight router (routing.ts) so a turn that gets
 * the data playbook and a turn that gets routed to a Data Analyst slot are the
 * same turn.
 */
export function looksLikeDataWork(text: string, attachmentNames: readonly string[] = []): boolean {
  if (attachmentNames.some((n) => TABULAR_FILE.test(n))) return true
  return DATA_INTENT.test(text)
}

/**
 * Choose the playbook for a turn, or null. Reference domains win in their
 * severity order; then data, code, comparison, planning. Creative requests
 * ("write a poem") get nothing — the classifiers already exclude them.
 */
export function selectPlaybook(input: { text: string; attachmentNames?: string[] }): Playbook | null {
  const text = input.text.trim()
  if (text.length < 8) return null
  for (const domain of referenceDomains(text)) {
    const id = DOMAIN_TO_PLAYBOOK[domain]
    if (id) return PLAYBOOKS[id]
  }
  if (looksLikeDataWork(text, input.attachmentNames ?? [])) return PLAYBOOKS['data-analysis']
  if (CODE_SIGNAL.test(text)) return PLAYBOOKS.coding
  if (COMPARE_INTENT.test(text)) return PLAYBOOKS.compare
  if (PLAN_INTENT.test(text)) return PLAYBOOKS.planning
  return null
}

/** The turn-notes block: the method, numbered, with a one-line frame. */
export function buildPlaybookContext(playbook: Playbook): string {
  return (
    `Method for this kind of question (the app's "${playbook.name}" playbook — follow it, and keep the answer to what it asks for):\n` +
    playbook.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  )
}
