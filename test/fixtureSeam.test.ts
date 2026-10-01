import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isResearchFixtureAlias, isResearchFixtureOrigin, throughResearchFixture } from '../src/main/ipc/fixtureSeam'
import { readSource } from './harness'

/**
 * v4.3: the research fixture seam and its alias (src/main/ipc/fixtureSeam.ts).
 * The live-world suite shows the model an ordinary https address; every path
 * a request could leave by must send it to the loopback fixture or refuse it.
 */

const ORIGIN = 'http://127.0.0.1:41234'
const ALIAS = 'https://www.harrowgate-dunmore-courier.com'
const KEYS = ['SIGMA_RESEARCH_FIXTURE_ORIGIN', 'SIGMA_RESEARCH_FIXTURE_ALIAS'] as const
const set = (origin?: string, alias?: string): void => {
  for (const k of KEYS) delete process.env[k]
  if (origin) process.env.SIGMA_RESEARCH_FIXTURE_ORIGIN = origin
  if (alias) process.env.SIGMA_RESEARCH_FIXTURE_ALIAS = alias
}

describe('the research fixture seam', () => {
  afterEach(() => set())

  test('closed, it recognizes nothing and rewrites nothing — the shipped app', () => {
    set()
    assert.equal(isResearchFixtureOrigin(new URL(`${ORIGIN}/a`)), false)
    assert.equal(isResearchFixtureAlias(new URL(`${ALIAS}/a`)), false)
    assert.equal(throughResearchFixture(`${ALIAS}/a.html?x=1`), `${ALIAS}/a.html?x=1`)
  })

  test('the alias is honoured only beside the origin', () => {
    set(undefined, ALIAS)
    assert.equal(isResearchFixtureOrigin(new URL(`${ALIAS}/a`)), false)
    assert.equal(throughResearchFixture(`${ALIAS}/a`), `${ALIAS}/a`)
  })

  test('open, the alias is admitted, and a request to it goes to the fixture, path and query kept', () => {
    set(ORIGIN, ALIAS)
    assert.equal(isResearchFixtureOrigin(new URL(`${ORIGIN}/a`)), true)
    assert.equal(isResearchFixtureOrigin(new URL(`${ALIAS}/a`)), true)
    assert.equal(isResearchFixtureAlias(new URL(`${ALIAS}/a`)), true)
    assert.equal(isResearchFixtureAlias(new URL(`${ORIGIN}/a`)), false)
    assert.equal(throughResearchFixture(`${ALIAS}/harrowgate-forecast.html?day=0`), `${ORIGIN}/harrowgate-forecast.html?day=0`)
    assert.equal(throughResearchFixture('https://example.com/a'), 'https://example.com/a')
  })

  test('whole origins only: another subdomain, scheme or port is not the alias', () => {
    set(ORIGIN, ALIAS)
    for (const u of ['https://harrowgate-dunmore-courier.com/a', 'http://www.harrowgate-dunmore-courier.com/a', 'https://www.harrowgate-dunmore-courier.com:8443/a', 'https://www.harrowgate-dunmore-courier.com.evil.example/a']) {
      assert.equal(isResearchFixtureOrigin(new URL(u)), false, u)
      assert.equal(throughResearchFixture(u), u, u)
    }
  })

  test('an alias that is not HTTPS is ignored', () => {
    set(ORIGIN, 'http://www.harrowgate-dunmore-courier.com')
    assert.equal(isResearchFixtureOrigin(new URL('http://www.harrowgate-dunmore-courier.com/a')), false)
    assert.equal(throughResearchFixture('http://www.harrowgate-dunmore-courier.com/a'), 'http://www.harrowgate-dunmore-courier.com/a')
  })

  test('every exit consults it: the egress chokepoint sends through it, the renderer refuses the alias, the guard admits it unresolved', () => {
    assert.match(readSource('src/main/ipc/net.ts'), /httpRequest\(throughResearchFixture\(url\), \{/)
    const render = readSource('src/main/ipc/render.ts')
    assert.match(render, /if \(isResearchFixtureAlias\(target\)\) \{\n\s+return \{ ok: false, error: 'Refused: the research fixture alias is never rendered\.' \}/)
    assert.ok(render.indexOf('isResearchFixtureAlias(target)') < render.indexOf('session.fromPartition'), 'refused before a session exists')
    assert.match(readSource('src/main/ipc/search/ssrf.ts'), /if \(isResearchFixtureOrigin\(url\)\) return/)
  })
})
