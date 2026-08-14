import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './harness'

const { shouldAllowRequest } = load<typeof import('../src/main/ipc/render')>('render')
const { shouldRender } = load<typeof import('../src/main/ipc/search')>('search')
const { PAGE_EXTRACTION_SCRIPT } = load<typeof import('../src/main/ipc/pageScript')>('pageScript')

/**
 * `shouldAllowRequest` is the privacy boundary of the whole rendering feature:
 * a browser reaches the network on its own, so this predicate is the only thing
 * standing between "render a page" and "let an ad network see the user". It is
 * asserted directly rather than only through a live browser.
 */
describe('shouldAllowRequest — the render egress filter', () => {
  const target = 'example.com'

  test('allows the target page itself', () => {
    assert.equal(
      shouldAllowRequest('https://example.com/article', 'mainFrame', target).allow,
      true
    )
  })

  test('allows first-party scripts, styles and XHR (needed to render text)', () => {
    for (const type of ['script', 'stylesheet', 'xhr', 'subFrame']) {
      assert.equal(shouldAllowRequest('https://example.com/a.js', type, target).allow, true, type)
    }
  })

  test('treats www and bare host as the same site', () => {
    assert.equal(shouldAllowRequest('https://www.example.com/a.js', 'script', target).allow, true)
  })

  test('blocks every third-party request', () => {
    const thirdParties = [
      'https://google-analytics.com/collect',
      'https://fonts.googleapis.com/css',
      'https://cdn.jsdelivr.net/lib.js',
      'https://doubleclick.net/pixel.gif',
      'https://evil.example.org/exfil?d=secret'
    ]
    for (const url of thirdParties) {
      const result = shouldAllowRequest(url, 'script', target)
      assert.equal(result.allow, false, url)
      assert.equal(result.reason, 'third-party request')
    }
  })

  test('blocks a subdomain of the target, which is still a different host', () => {
    assert.equal(shouldAllowRequest('https://tracking.example.com/x', 'script', target).allow, false)
  })

  test('blocks resource types that cannot carry text, even first-party', () => {
    for (const type of ['image', 'media', 'font', 'webSocket', 'ping', 'cspReport', 'other']) {
      const result = shouldAllowRequest('https://example.com/asset', type, target)
      assert.equal(result.allow, false, type)
      assert.match(result.reason!, /resource type/)
    }
  })

  test('blocks non-HTTP schemes', () => {
    for (const url of ['ws://example.com/s', 'wss://example.com/s', 'file:///etc/passwd']) {
      assert.equal(shouldAllowRequest(url, 'xhr', target).allow, false, url)
    }
  })

  test('blocks an unparseable URL rather than defaulting to allow', () => {
    const result = shouldAllowRequest('http://[not a url', 'script', target)
    assert.equal(result.allow, false)
    assert.equal(result.reason, 'unparseable URL')
  })

  test('every decision carries a reason, so the log explains itself', () => {
    const blocked = shouldAllowRequest('https://other.org/x', 'image', target)
    assert.equal(blocked.allow, false)
    assert.ok(blocked.reason && blocked.reason.length > 0)
  })

  /**
   * Only a third-party refusal means an origin was kept out entirely. A
   * same-site image or font is refused by resource type, but that origin was
   * still contacted for the document — so counting it as a blocked origin
   * overstates what was refused. Rendering excalidraw.com reported five
   * "third-party origins blocked" when one of the five was excalidraw.com.
   */
  describe('thirdParty — which refusals count as an origin kept out', () => {
    test('a third-party refusal is flagged', () => {
      assert.equal(shouldAllowRequest('https://sentry.io/x', 'script', target).thirdParty, true)
    })

    test('a same-site refusal is not, even though it is still blocked', () => {
      const result = shouldAllowRequest('https://example.com/logo.png', 'image', target)
      assert.equal(result.allow, false)
      assert.ok(!result.thirdParty, 'the page’s own origin was contacted, not kept out')
    })

    test('www and bare host count as the same site here too', () => {
      const result = shouldAllowRequest('https://www.example.com/f.woff', 'font', target)
      assert.equal(result.allow, false)
      assert.ok(!result.thirdParty)
    })

    test('an unparseable URL is not reported as a third-party origin', () => {
      // originOfUrl cannot name it, so it must not reach the reported list.
      const result = shouldAllowRequest('http://[not a url', 'script', target)
      assert.equal(result.allow, false)
      assert.ok(!result.thirdParty)
    })

    test('an allowed request is never flagged', () => {
      assert.ok(!shouldAllowRequest('https://example.com/a.js', 'script', target).thirdParty)
    })
  })
})

describe('shouldRender — static-first escalation', () => {
  const goodText = 'A'.repeat(600)

  test('does not render when static extraction already produced text', () => {
    assert.equal(shouldRender('html', goodText, '<html><body>...</body></html>').render, false)
  })

  test('does not render a PDF — there are no scripts to run', () => {
    assert.equal(shouldRender('pdf', '', '').render, false)
  })

  test('does not render plain text', () => {
    assert.equal(shouldRender('text', '', '').render, false)
  })

  test('renders when static extraction produced nothing', () => {
    const decision = shouldRender('html', '', '<html><body></body></html>')
    assert.equal(decision.render, true)
    assert.match(decision.reason!, /no text at all/)
  })

  test('renders when the page is a recognizable app shell', () => {
    const shells = [
      '<div id="root"></div>',
      '<div id="__next"></div>',
      '<div id="app"></div>',
      '<noscript>You need to enable JavaScript to run this app.</noscript>',
      '<script>window.__NUXT__={}</script>',
      '<div data-reactroot></div>'
    ]
    for (const shell of shells) {
      assert.equal(shouldRender('html', 'a bit of text', shell).render, true, shell)
    }
  })

  test('an app shell that already rendered server-side is not re-rendered', () => {
    // Next.js SSR: the marker is present but so is the content. Rendering would
    // be pure waste and an extra set of requests.
    assert.equal(shouldRender('html', goodText, '<div id="__next">' + goodText + '</div>').render, false)
  })

  test('reports how thin the static result was', () => {
    const decision = shouldRender('html', 'short', '<html><body>short</body></html>')
    assert.equal(decision.render, true)
    assert.match(decision.reason!, /only \d+ characters/)
  })
})

describe('PAGE_EXTRACTION_SCRIPT', () => {
  // The script runs in a browser, so behavior is covered end-to-end by
  // scripts/test-render.sh against a real offscreen window. These checks guard
  // the properties that matter before it ever gets injected.
  test('is a self-contained expression that returns a value', () => {
    assert.match(PAGE_EXTRACTION_SCRIPT.trim(), /^\(function \(\) \{/)
    assert.match(PAGE_EXTRACTION_SCRIPT.trim(), /\}\)\(\)$/)
  })

  test('reads the DOM but never sends anything', () => {
    // A page script that could make requests would sidestep the webRequest
    // filter entirely, so the absence of these is load-bearing.
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'import(']) {
      assert.ok(!PAGE_EXTRACTION_SCRIPT.includes(forbidden), forbidden)
    }
  })

  test('checks computed style for every way text can be hidden', () => {
    for (const signal of [
      'display',
      'visibility',
      'opacity',
      'aria-hidden',
      'fontSize',
      'clipPath',
      'textIndent'
    ]) {
      assert.ok(PAGE_EXTRACTION_SCRIPT.includes(signal), signal)
    }
  })

  test('reports how much hidden text it dropped', () => {
    assert.ok(PAGE_EXTRACTION_SCRIPT.includes('hiddenTextRemoved'))
  })

  test('excludes links by ancestor, matching the static path', () => {
    // The two paths must agree on what counts as a link for the same page: the
    // static path builds links from chrome-stripped HTML, so the rendered path
    // has to walk ancestors rather than inspect the anchor alone.
    assert.ok(PAGE_EXTRACTION_SCRIPT.includes('isExcluded'))
    assert.ok(/isExcluded\(a\)/.test(PAGE_EXTRACTION_SCRIPT))
  })
})
