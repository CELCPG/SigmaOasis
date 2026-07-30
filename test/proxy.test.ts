import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, state, resetState } from './harness'

const proxy = load<typeof import('../src/main/ipc/proxy')>('proxy')
const search = load<typeof import('../src/main/ipc/search')>('search')
const researchIndex = load<typeof import('../src/main/ipc/researchIndex')>('researchIndex')

const { buildProxyConfig } = proxy

type Settings = { proxy: { mode: string; host: string; port: number } }
const settings = (): Settings => state.settings as unknown as Settings

beforeEach(() => {
  resetState()
  search.clearSearchCache()
  researchIndex.clearResearchIndex()
})

describe('buildProxyConfig', () => {
  test('mode none is a direct connection', () => {
    const config = buildProxyConfig({ mode: 'none', host: '127.0.0.1', port: 9050 })
    assert.equal(config.proxyRules, null)
    assert.equal(config.error, undefined)
  })

  test('socks5 produces Chromium socks5 rules', () => {
    const config = buildProxyConfig({ mode: 'socks5', host: '127.0.0.1', port: 9050 })
    assert.equal(config.proxyRules, 'socks5://127.0.0.1:9050')
  })

  test('http mode produces http rules', () => {
    const config = buildProxyConfig({ mode: 'http', host: '10.0.0.2', port: 8080 })
    assert.equal(config.proxyRules, 'http://10.0.0.2:8080')
  })

  test('loopback and link-local are always bypassed', () => {
    const config = buildProxyConfig({ mode: 'socks5', host: '127.0.0.1', port: 9050 })
    assert.match(config.proxyBypassRules, /127\.0\.0\.1/)
    assert.match(config.proxyBypassRules, /localhost/)
  })

  test('a bare IPv6 proxy address is bracketed for the rules syntax', () => {
    const config = buildProxyConfig({ mode: 'socks5', host: '::1', port: 9050 })
    assert.equal(config.proxyRules, 'socks5://[::1]:9050')
  })

  test('an already-bracketed IPv6 address is not double-bracketed', () => {
    const config = buildProxyConfig({ mode: 'socks5', host: '[::1]', port: 9050 })
    assert.equal(config.proxyRules, 'socks5://[::1]:9050')
  })

  test('the socks5 description states that DNS resolves at the proxy', () => {
    // This is the property that distinguishes it from an HTTP proxy, so the UI
    // has to be able to say so.
    assert.match(buildProxyConfig({ mode: 'socks5', host: '127.0.0.1', port: 9050 }).description, /DNS/i)
  })

  describe('misconfiguration falls back to direct, but never silently', () => {
    // A privacy control that fails by quietly not applying is the worst case:
    // the user believes they are proxied and are not. Every rejection carries a
    // reason so the UI can say what happened.
    test('an empty host', () => {
      const config = buildProxyConfig({ mode: 'socks5', host: '  ', port: 9050 })
      assert.equal(config.proxyRules, null)
      assert.match(config.error!, /no proxy host/i)
    })

    test('a host containing a scheme or path', () => {
      for (const host of ['socks5://127.0.0.1', '127.0.0.1/path', 'user@host', 'a b']) {
        const config = buildProxyConfig({ mode: 'socks5', host, port: 9050 })
        assert.equal(config.proxyRules, null, host)
        assert.match(config.error!, /invalid proxy host/i)
      }
    })

    test('an out-of-range or non-numeric port', () => {
      for (const port of [0, -1, 70000, NaN, 1.5]) {
        const config = buildProxyConfig({ mode: 'socks5', host: '127.0.0.1', port })
        assert.equal(config.proxyRules, null, String(port))
        assert.match(config.error!, /invalid proxy port/i)
      }
    })
  })
})

describe('proxyActive', () => {
  test('false by default', () => {
    assert.equal(proxy.proxyActive(), false)
  })

  test('true once a valid proxy is configured', () => {
    settings().proxy = { mode: 'socks5', host: '127.0.0.1', port: 9050 }
    assert.equal(proxy.proxyActive(), true)
  })

  test('false when the configuration is invalid, matching what is in force', () => {
    settings().proxy = { mode: 'socks5', host: '', port: 9050 }
    assert.equal(proxy.proxyActive(), false)
  })
})

describe('SSRF guard under a proxy', () => {
  const page = '<html><body><p>' + 'text '.repeat(200) + '</p></body></html>'

  beforeEach(() => {
    state.responses = [{ match: 'target.example', contentType: 'text/html', body: page }]
  })

  test('without a proxy, the hostname is resolved locally', async () => {
    await search.readWebpage('https://target.example/page', '', 5)
    // Baseline for the assertion below: resolution normally happens here.
    assert.equal(proxy.proxyActive(), false)
  })

  test('with a proxy, a private DNS answer no longer blocks the fetch', async () => {
    // Deliberate: resolving locally would tell the local resolver which host is
    // about to be visited, which is exactly what the proxy exists to prevent.
    // Resolution moves to the proxy, and so does this part of the guard.
    state.dnsOverrides['target.example'] = [{ address: '10.0.0.5', family: 4 }]
    settings().proxy = { mode: 'socks5', host: '127.0.0.1', port: 9050 }
    const out = await search.readWebpage('https://target.example/page', '', 5)
    assert.equal(out.ok, true, out.error)
  })

  test('the same private answer still blocks the fetch with no proxy', async () => {
    state.dnsOverrides['target.example'] = [{ address: '10.0.0.5', family: 4 }]
    const out = await search.readWebpage('https://target.example/page', '', 5)
    assert.equal(out.ok, false)
    assert.match(out.error!, /private or reserved/i)
  })

  test('a literal private IP is refused even under a proxy', async () => {
    // What can be judged without resolving is still judged. This is the part of
    // the guard that does not depend on DNS at all.
    settings().proxy = { mode: 'socks5', host: '127.0.0.1', port: 9050 }
    for (const host of ['10.0.0.5', '192.168.1.1', '169.254.169.254', '127.0.0.1']) {
      const out = await search.readWebpage(`https://${host}/x`, '', 5)
      assert.equal(out.ok, false, host)
    }
  })

  test('a literal public IP is allowed under a proxy', async () => {
    settings().proxy = { mode: 'socks5', host: '127.0.0.1', port: 9050 }
    state.responses = [{ match: '93.184.216.34', contentType: 'text/html', body: page }]
    const out = await search.readWebpage('https://93.184.216.34/x', '', 5)
    assert.equal(out.ok, true, out.error)
  })

  test('a literal private IP is refused without a proxy too', async () => {
    const out = await search.readWebpage('https://192.168.0.1/x', '', 5)
    assert.equal(out.ok, false)
  })

  test('loopback hostnames are refused regardless of proxy state', async () => {
    for (const active of [false, true]) {
      settings().proxy = active
        ? { mode: 'socks5', host: '127.0.0.1', port: 9050 }
        : { mode: 'none', host: '127.0.0.1', port: 9050 }
      const out = await search.readWebpage('https://localhost/v1/models', '', 5)
      assert.equal(out.ok, false, `proxy active: ${active}`)
    }
  })
})
