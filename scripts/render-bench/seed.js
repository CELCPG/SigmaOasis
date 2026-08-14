// Builds a throwaway profile for one benchmark run: settings pointed at the
// stub, plus a conversation that is already a dozen exchanges long.
//
// The prior conversation is not decoration. A per-token re-render cascade
// costs nothing when there is one bubble on screen, so measuring an empty
// conversation is measuring the best case and will show no difference at all —
// the first version of this benchmark did exactly that and reported a clean
// null result.
const fs = require('fs')
const path = require('path')

const profile = process.argv[2]
const pairs = Number(process.argv[3] || 12)
const stubPort = Number(process.env.BENCH_STUB_PORT || 1235)

const TOOLS = [
  'read_file', 'write_file', 'list_directory', 'run_terminal_command',
  'web_search', 'image_search', 'fetch_webpage', 'date_calculator', 'geo_locate',
  'get_current_datetime', 'create_note', 'list_notes', 'read_note',
  'memory_save', 'memory_search', 'memory_forget', 'deep_research',
  'finance_calculator', 'shop_requirements', 'shop_compare', 'price_watch'
]

// Everything that would fire a second model call or a network request is off:
// they are identical across versions and only add variance to the measurement.
const settings = {
  baseUrl: `http://127.0.0.1:${stubPort}/v1`,
  onboardingCompleted: true,
  models: [
    {
      id: 'model-1',
      modelId: 'bench-model',
      roleName: 'Assistant',
      systemPrompt: 'You are a helpful assistant.',
      color: 'blue',
      enabled: true,
      sampling: { temperature: 0, topP: 1, maxTokens: -1, seed: 1, topK: -1, minP: -1 },
      contextWindow: null
    }
  ],
  tools: Object.fromEntries(TOOLS.map((t) => [t, false])),
  memory: { autoContext: false, topK: 3, embeddingModel: '' },
  claimCheck: { enabled: false, maxClaims: 5 },
  grounding: { autoCorrect: false },
  secondOpinion: { enabled: false, criticSlotId: null },
  updates: { autoCheck: false },
  audit: { enabled: false, autoPurgeOnQuit: false }
}

fs.mkdirSync(profile, { recursive: true })
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ settings }, null, 2))

const dir = path.join(profile, 'conversations')
fs.mkdirSync(dir, { recursive: true })

const now = Date.now()
const messages = []
for (let i = 0; i < pairs; i++) {
  const at = now - (pairs - i) * 60_000
  messages.push({
    id: `u${i}`,
    role: 'user',
    content: `Question ${i + 1}: how should the ${['parser', 'cache', 'router', 'indexer'][i % 4]} handle a malformed record?`,
    createdAt: at
  })
  messages.push({
    id: `a${i}`,
    role: 'assistant',
    modelId: 'bench-model',
    roleName: 'Assistant',
    color: 'blue',
    toolCalls: [],
    content:
      `Reply ${i + 1}. It should raise rather than coerce: a record that cannot be ` +
      'parsed is a fact about the input, and swallowing it moves the failure ' +
      'somewhere less informative.\n\n' +
      '```python\n' +
      `def handle_${i}(record):\n` +
      '    if not isinstance(record, dict):\n' +
      '        raise TypeError(f"expected dict, got {type(record).__name__}")\n' +
      '    return {k: v for k, v in record.items() if v is not None}\n' +
      '```\n\n' +
      "Log the record's identifier and the field that failed, never the whole record — " +
      'it may carry values that should not reach a log file.',
    createdAt: at + 30_000
  })
}

fs.writeFileSync(
  path.join(dir, 'bench-conversation.json'),
  JSON.stringify(
    {
      id: 'bench-conversation',
      title: 'Implementation questions',
      mode: 'independent',
      activeModelSlotId: 'model-1',
      messages,
      createdAt: now - pairs * 60_000,
      updatedAt: now
    },
    null,
    2
  )
)

console.log(`seed: profile at ${profile} with ${messages.length} prior messages`)
