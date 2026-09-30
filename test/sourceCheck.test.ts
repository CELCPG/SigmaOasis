import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SOURCE_CLAIMS,
  SOURCE_CHECK_MAX_TOKENS,
  buildSourceCheckMessages,
  checkAgainstSources,
  checkableClaims,
  describeSourceCheck,
  evidenceFor,
  findingFor,
  findingsStanding,
  parseSourceVerdict,
  withSourceFindings
} from '../src/renderer/src/lib/sourceCheck'
import { numberWebSources } from '../src/renderer/src/lib/webSources'
import { passagesHandedOver } from '../src/renderer/src/lib/citations'
import {
  describeGroundingFindings,
  groundingFindingCount,
  groundingFindingLabels
} from '../src/renderer/src/lib/toolGrounding'
import { CLOSED_THINK_PREFILL } from '../src/shared/thinking'
import type { ChatMessage, Conversation, ModelConfig, ToolCallRecord } from '../src/renderer/src/types'

/**
 * v4.1 (G4): a sourced reply's specifics, checked one at a time against this
 * turn's own sources by the answering model. The model is scripted here; the
 * pass around it is not.
 */

const SEARCH =
  '[untrusted]\n\nSearch results for "heat next game" via duckduckgo:\n\n' +
  '1. Heat vs Knicks preview\n   https://news.example/heat-knicks\n   Tip-off is 8:00 PM ET on Wednesday, Oct 21.\n\n' +
  '2. Heat roster\n   https://team.example/roster\n   Bam Adebayo and Tyler Herro lead the team.'
const PAGE =
  '[untrusted]\n\nPage: Heat vs Knicks preview\nURL: https://news.example/heat-knicks\n\n' +
  '--- passage 1 ---\nThe Heat open at home against the Knicks on Wednesday, October 21, at 8:00 PM ET.'

function numbered(): ToolCallRecord[] {
  const records: ToolCallRecord[] = []
  let id = 0
  const add = (name: string, args: Record<string, unknown>, out: string): void => {
    records.push({ id: `r${++id}`, name, args, status: 'done', result: numberWebSources(name, args, out, records, passagesHandedOver(records)) })
  }
  add('web_search', { query: 'heat next game' }, SEARCH)
  add('fetch_webpage', { url: 'https://news.example/heat-knicks' }, PAGE)
  return records
}

const REPLY =
  'The Heat play the Knicks on **Tuesday, October 20** at 7:30 PM ET [1]. ' +
  'Bam Adebayo leads the team [2]. Would you like the broadcast channel? ' +
  'I could not verify the ticket prices.'

describe('checkableClaims', () => {
  test('specifics first, then names; questions and asides about the reply are not claims', () => {
    const claims = checkableClaims(REPLY)
    assert.deepEqual(
      claims.map((c) => c.sentence),
      ['The Heat play the Knicks on Tuesday, October 20 at 7:30 PM ET .', 'Bam Adebayo leads the team .']
    )
    assert.deepEqual(claims[0].cites, [1])
  })

  test('at most six', () => {
    const many = Array.from({ length: 10 }, (_, i) => `Game ${i + 1} starts at ${i + 1} PM on the road.`).join(' ')
    assert.equal(checkableClaims(many).length, MAX_SOURCE_CLAIMS)
  })
})

describe('evidence', () => {
  test('a cited sentence is checked against what it cites — the page, not the snippet', () => {
    const [claim] = checkableClaims(REPLY)
    const records = numbered()
    const evidence = evidenceFor(claim, [
      { index: 1, label: 'Heat vs Knicks preview', text: 'The Heat open at home against the Knicks on Wednesday, October 21, at 8:00 PM ET.' },
      { index: 2, label: 'Heat roster', text: 'Bam Adebayo and Tyler Herro lead the team.' }
    ])
    assert.match(evidence, /^\[1\] Heat vs Knicks preview\nThe Heat open at home/)
    assert.doesNotMatch(evidence, /roster/)
    assert.ok(records.length === 2)
  })

  test('an uncited sentence gets the passages that share its terms, and none that share nothing', () => {
    const evidence = evidenceFor({ sentence: 'Tyler Herro scored 30 points.', cites: [] }, [
      { index: 1, label: 'A', text: 'Weather is sunny.' },
      { index: 2, label: 'B', text: 'Tyler Herro scored 28 points.' }
    ])
    assert.match(evidence, /^\[2\] B/)
    assert.doesNotMatch(evidence, /sunny/)
  })
})

describe('the verdict and what it makes', () => {
  test('only an explicit verdict counts; anything else is "not found"', () => {
    assert.equal(parseSourceVerdict('VERDICT: CONTRADICTED\nBASIS: the page says Wednesday'), 'contradicted')
    assert.equal(parseSourceVerdict('verdict: supported'), 'supported')
    assert.equal(parseSourceVerdict('It seems likely.'), 'not_found')
  })

  test('contradicted is a finding; "not found" is one only for a sentence that cites a source', () => {
    const cited = { sentence: 'Tip-off is at 7:30 PM.', cites: [1] }
    const bare = { sentence: 'Tip-off is at 7:30 PM.', cites: [] }
    const known = new Set([1])
    assert.match(findingFor(bare, 'contradicted', known)!.finding, /sources say otherwise/)
    assert.match(findingFor(cited, 'not_found', known)!.finding, /\[1\] does not state this/)
    assert.equal(findingFor(bare, 'not_found', known), null)
    assert.equal(findingFor(cited, 'supported', known), null)
    assert.equal(findingFor({ ...cited, cites: [9] }, 'not_found', known), null, 'a marker naming nothing is the dangling check\'s')
  })

  test('the prompt closes thinking for a <think> family, and only there', () => {
    const claim = { sentence: 'x at 7 PM', cites: [] }
    assert.equal(buildSourceCheckMessages(claim, 'e', 'qwen3.8-9b').at(-1)?.content, CLOSED_THINK_PREFILL)
    assert.equal(buildSourceCheckMessages(claim, 'e', 'gemma-4-12b').at(-1)?.role, 'user')
  })
})

describe('checkAgainstSources · the pass', () => {
  test('one completion per checkable claim; a contradiction becomes a finding', async () => {
    const asked: string[] = []
    const out = await checkAgainstSources(REPLY, numbered(), 'qwen3.8-9b', {
      aborted: () => false,
      complete: async (messages) => {
        const user = messages.find((m) => m.role === 'user')!.content
        asked.push(user)
        return /Tuesday/.test(user) ? 'VERDICT: CONTRADICTED\nBASIS: Wednesday' : 'VERDICT: SUPPORTED'
      }
    })
    assert.equal(asked.length, 2)
    assert.equal(out.checked, 2)
    assert.deepEqual(out.findings.map((f) => f.verdict), ['contradicted'])
    assert.equal(out.ran, true)
  })

  test('no sources, nothing asked', async () => {
    let calls = 0
    const out = await checkAgainstSources(REPLY, [], 'm', { aborted: () => false, complete: async () => `${calls++}` })
    assert.deepEqual(out, { ran: false, checked: 0, findings: [], cut: false })
  })

  test('the budget stops it between claims and says so', async () => {
    let t = 0
    const out = await checkAgainstSources(
      REPLY,
      numbered(),
      'm',
      { aborted: () => false, now: () => t, complete: async () => ((t += 25_000), 'VERDICT: SUPPORTED') },
      20_000
    )
    assert.equal(out.checked, 1)
    assert.equal(out.cut, true)
  })
})

describe('into the report and the one revision', () => {
  const finding = findingFor({ sentence: 'Tip-off is at 7:30 PM ET .', cites: [1] }, 'contradicted', new Set([1]))!

  test('a finding stands while its sentence does, and not after the revision rewrites it', () => {
    assert.deepEqual(findingsStanding([finding], 'Tip-off is at **7:30 PM ET** [1].'), [finding.finding])
    assert.deepEqual(findingsStanding([finding], 'Tip-off is at 8:00 PM ET [1].'), [])
  })

  test('joined into the report, counted, labelled and sent back like any rung', () => {
    const report = withSourceFindings(null, [finding.finding], numbered())!
    assert.deepEqual(report.checkedAgainst, ['fetch_webpage', 'web_search'])
    assert.equal(groundingFindingCount(report), 1)
    assert.equal(groundingFindingLabels(report).length, 1)
    assert.match(describeGroundingFindings(report), /Checked one by one against this turn's sources/)
    assert.equal(withSourceFindings(null, [], []), null)
  })

  test('the check line', () => {
    assert.equal(describeSourceCheck(3, [], false).ok, true)
    assert.match(describeSourceCheck(3, [finding], true).summary, /Checked 3 sentences.*1 contradicted.*time limit/)
  })
})

// ---- the tail, end to end, with the model scripted over fetch ---------------

const slot = { id: 's', modelId: 'qwen3.8-9b', roleName: 'Assistant', enabled: true, contextWindow: 8192, sampling: { temperature: 0.7, topP: 1, maxTokens: -1, seed: null, topK: -1, minP: -1 } } as unknown as ModelConfig

const originalFetch = globalThis.fetch
const bodies: Record<string, unknown>[] = []
beforeEach(async () => {
  bodies.length = 0
  ;(globalThis as { window?: unknown }).window = {
    api: {
      ledgerUpsert: async () => ({ ok: true, written: [], refreshed: [], superseded: 0 }),
      saveConversation: async () => true
    }
  }
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { content: string }[] }
    bodies.push(body as unknown as Record<string, unknown>)
    const user = body.messages.map((m) => m.content).join('\n')
    const text = /Tuesday/.test(user) ? 'VERDICT: CONTRADICTED\nBASIS: Wednesday' : 'VERDICT: SUPPORTED'
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

async function tail(sourceCheck: boolean): Promise<{ patches: Partial<ChatMessage>[]; phases: (string | null)[] }> {
  const { useAppStore } = await import('../src/renderer/src/stores/appStore')
  const { startTurnTail } = await import('../src/renderer/src/hooks/turnTail')
  useAppStore.setState({
    settings: {
      models: [slot],
      grounding: { workbenchChecks: false, autoCorrect: false, factLedger: false, sourceCheck },
      claimCheck: { enabled: false },
      secondOpinion: { enabled: false }
    } as never,
    conversations: [],
    availableModels: []
  } as never)
  const patches: Partial<ChatMessage>[] = []
  const phases: (string | null)[] = []
  const assistantMsg = { id: 'a1', role: 'assistant', content: REPLY, createdAt: 0 } as ChatMessage
  const convo = {
    id: 'c1',
    title: 't',
    messages: [{ id: 'u1', role: 'user', content: 'when do the heat play next?', createdAt: 0 }, assistantMsg]
  } as unknown as Conversation
  await startTurnTail({
    convo,
    slot,
    slotTools: [],
    tools: [],
    baseUrl: 'http://127.0.0.1:1/v1',
    signal: new AbortController().signal,
    assistantMsg,
    patch: (p) => patches.push(p),
    verifying: (step) => phases.push(step),
    allRecords: numbered(),
    toolContext: {},
    lastUserContent: 'when do the heat play next?',
    shoppingTurn: false,
    checkableTurn: true,
    answerEndedAt: Date.now(),
    lastStats: null,
    turnOpenedAt: Date.now()
  }).run()
  return { patches, phases }
}

describe('the tail · a sourced turn with the check on', () => {
  test('each claim is asked with thinking closed, 60 tokens, temperature 0; the contradiction reaches the badge', async () => {
    const { patches, phases } = await tail(true)
    assert.ok(phases.includes('sources'))
    assert.equal(bodies.length, 2)
    for (const b of bodies) {
      assert.equal(b.max_tokens, SOURCE_CHECK_MAX_TOKENS)
      assert.equal(b.temperature, 0)
      assert.deepEqual(b.tools, undefined)
    }
    const grounding = patches.map((p) => p.grounding).filter(Boolean).at(-1)
    assert.equal(grounding?.sourceMismatches?.length, 1)
    assert.match(grounding!.sourceMismatches![0], /Tuesday, October 20.*sources say otherwise/)
    const line = patches.flatMap((p) => p.checks ?? []).find((c) => c.kind === 'sources')
    assert.match(line?.summary ?? '', /Checked 2 sentences/)
  })

  test('off — the default — asks the model nothing', async () => {
    const { phases } = await tail(false)
    assert.equal(bodies.length, 0)
    assert.ok(!phases.includes('sources'))
  })
})
