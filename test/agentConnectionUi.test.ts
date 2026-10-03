import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readSource } from './harness'
import { ConnectionTab } from '../src/renderer/src/components/settings/ConnectionTab'
import { agentConnectionLabel, connectionHint } from '../src/renderer/src/components/agent/AgentBar'
import type { AppSettings } from '../src/renderer/src/types'

/**
 * 4.6 (J1): the agent connection on screen — its card under Settings →
 * Connection, and the agent chat's own header and panel saying which model and
 * server run it. The card's controls are the kit's (the Electron settings-kit,
 * contrast, button-name and tab-traversal checks walk it in the built app);
 * this is what each state draws.
 */

const settings = (agentConnection?: AppSettings['agentConnection']): AppSettings =>
  ({
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: [{ id: 'model-1', roleName: 'Coder', modelId: 'qwen3.8-9b-distill', enabled: true, color: 'blue', specialty: 'coding', sampling: {} }],
    ...(agentConnection ? { agentConnection } : {})
  }) as unknown as AppSettings

const tab = (s: AppSettings): string =>
  renderToStaticMarkup(createElement(ConnectionTab, { settings: s, apply: () => undefined, availableModels: [], connection: 'online', refresh: async () => undefined }))

/** The agent connection's card, cut out of the tab: from its test id to the section after it. */
const card = (html: string): string => {
  const at = html.indexOf('data-testid="agent-connection"')
  assert.ok(at >= 0, 'the card is drawn')
  const end = html.indexOf('This machine', at)
  assert.ok(end > at, 'the card comes before "This machine"')
  return html.slice(at, end)
}

describe('Settings → LM Studio: the agent connection card', () => {
  test('off (and absent, as in a 4.5 file): a switch that is off, the address, no model picker, and the card says the agent runs on LM Studio', () => {
    for (const s of [settings(), settings({ enabled: false, baseUrl: 'http://127.0.0.1:8080/v1', model: '' })]) {
      const c = card(tab(s))
      assert.match(c, /Agent connection/)
      assert.match(c, /off — the agent runs on LM Studio/)
      assert.match(c, /role="switch"[^>]*aria-checked="false"/)
      assert.match(c, /value="http:\/\/127\.0\.0\.1:8080\/v1"/)
      assert.doesNotMatch(c, /Agent model/)
      assert.doesNotMatch(c, />Test</, 'nothing to test while it is off')
    }
  })

  test('on: the switch, the address, the model picker with the saved model, a status line, and the model and address in the title', () => {
    const c = card(tab(settings({ enabled: true, baseUrl: 'http://127.0.0.1:8081/v1', model: 'qwen3.8-35b-a3b' })))
    assert.match(c, /role="switch"[^>]*aria-checked="true"/)
    assert.match(c, /qwen3\.8-35b-a3b at http:\/\/127\.0\.0\.1:8081\/v1/)
    assert.match(c, /Agent model/)
    assert.match(c, /<select[^>]*data-kit/)
    assert.match(c, /<option value="qwen3\.8-35b-a3b"[^>]*>qwen3\.8-35b-a3b \(not listed\)<\/option>/, 'until the server has answered, the saved model is offered as it is')
    assert.match(c, /Connecting…/)
    assert.match(c, />Test</)
  })

  test('a non-loopback address gets the main address\'s notice', () => {
    const c = card(tab(settings({ enabled: true, baseUrl: 'http://10.0.0.10:8081/v1', model: '' })))
    assert.match(c, /Only servers on this machine are supported\. This address will not be kept/)
    assert.doesNotMatch(card(tab(settings({ enabled: true, baseUrl: 'http://localhost:8081/v1', model: '' }))), /Only servers on this machine/)
  })

  test('every control in the card sits in a Row with help, named by it', () => {
    const c = card(tab(settings({ enabled: true, baseUrl: 'http://127.0.0.1:8081/v1', model: '' })))
    for (const id of ['connection.agentConnection', 'connection.agentBaseUrl', 'connection.agentModel']) assert.match(c, new RegExp(`data-row="${id.replace('.', '\\.')}"`), id)
    assert.equal((c.match(/data-help/g) ?? []).length, 3)
    assert.match(c, /role="switch"[^>]*aria-labelledby=/)
  })
})

// The header and panel read the store, and a server render reads zustand's
// initial state, not a test's setState — so what they say is the pure label
// below, and the source is held to drawing it in both places.
describe('the agent chat says what runs it', () => {
  const source = readSource(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'agent', 'AgentBar.tsx'))

  test('off (or absent): no label — the slot\'s model is shown, as before', () => {
    assert.equal(agentConnectionLabel(undefined), null)
    assert.equal(agentConnectionLabel({ enabled: false, baseUrl: 'http://127.0.0.1:8081/v1', model: 'qwen3.8-35b-a3b' }), null)
    assert.match(source, /\) : enabled\.length > 1 \? \(\n\s*<Select/, 'off, the 4.5 slot picker')
  })

  test('on: the agent connection\'s model and address, in the header and the panel', () => {
    assert.deepEqual(agentConnectionLabel({ enabled: true, baseUrl: 'http://127.0.0.1:8081/v1', model: 'qwen3.8-35b-a3b' }), { model: 'qwen3.8-35b-a3b', baseUrl: 'http://127.0.0.1:8081/v1' })
    assert.deepEqual(agentConnectionLabel({ enabled: true, baseUrl: 'http://127.0.0.1:8081/v1', model: '' })?.model, 'the server’s model', 'no model named: the server\'s, not the slot\'s')
    assert.equal(connectionHint('http://127.0.0.1:8081/v1'), 'Runs on the agent connection, http://127.0.0.1:8081/v1 (Settings → LM Studio). Chat, embeddings and titles stay on LM Studio.')
    assert.match(source, /data-testid="agent-connection-label">\n\s*\{onAgent\.model\} · agent connection/)
    assert.match(source, /agent connection · \{onAgent\.baseUrl\}/)
    assert.equal((source.match(/const onAgent = useAgentConnection\(\)/g) ?? []).length, 2, 'the header and the panel')
  })
})
