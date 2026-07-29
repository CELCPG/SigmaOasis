import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './harness'

const {
  extractFromHtml,
  extractLinks,
  findMainContent,
  removeChrome,
  readElement,
  linkDensity,
  decodeEntities,
  stripTags,
  htmlToText
} = load<typeof import('../src/main/ipc/extract')>('extract')

/** Long enough that density scoring has something to work with. */
const ARTICLE_BODY =
  'The quick brown fox jumps over the lazy dog. '.repeat(20) +
  'Retry behaviour defaults to thirty seconds before the timeout fires. '.repeat(10)

describe('readElement', () => {
  test('matches nesting rather than the first closing tag', () => {
    const html = '<div id="outer">a<div id="inner">b</div>c</div>tail'
    const span = readElement(html, 'div', 0)
    assert.ok(span)
    assert.equal(span!.inner, 'a<div id="inner">b</div>c')
    assert.equal(html.slice(span!.end), 'tail')
  })

  test('captures the opening tag attributes', () => {
    const span = readElement('<div class="x y" data-n="1">t</div>', 'div', 0)
    assert.match(span!.attrs, /class="x y"/)
  })

  test('returns null for an unclosed element', () => {
    assert.equal(readElement('<div>text with no close', 'div', 0), null)
  })

  test('returns null when the tag is absent', () => {
    assert.equal(readElement('<p>hi</p>', 'div', 0), null)
  })

  test('handles a self-closing element without hanging', () => {
    const span = readElement('<div/>after', 'div', 0)
    assert.ok(span)
    assert.equal(span!.inner, '')
  })

  test('is not confused by a similarly-named tag', () => {
    // <divider> must not count as an opening <div>.
    const span = readElement('<div>a<divider>x</divider>b</div>', 'div', 0)
    assert.ok(span)
    assert.equal(span!.inner, 'a<divider>x</divider>b')
  })
})

describe('linkDensity', () => {
  test('prose has low density', () => {
    assert.ok(linkDensity(`<p>${ARTICLE_BODY}</p>`) < 0.1)
  })

  test('a nav list is almost entirely links', () => {
    const nav = '<ul>' + '<li><a href="/a">Home page link</a></li>'.repeat(10) + '</ul>'
    assert.ok(linkDensity(nav) > 0.9)
  })

  test('empty input is 0, not NaN', () => {
    assert.equal(linkDensity(''), 0)
  })
})

describe('removeChrome', () => {
  test('removes div-based chrome the v0.6 tag-only version kept', () => {
    const html = `
      <div class="site-navigation"><a href="/x">Nav Link</a><a href="/y">Another</a></div>
      <div class="content"><p>${ARTICLE_BODY}</p></div>
      <div class="cookie-consent">We use cookies</div>
      <div class="related-stories"><a href="/z">Related thing</a></div>`
    const out = removeChrome(html)
    assert.ok(!out.includes('Nav Link'))
    assert.ok(!out.includes('We use cookies'))
    assert.ok(!out.includes('Related thing'))
    assert.ok(out.includes('quick brown fox'))
  })

  test('removes semantic chrome tags', () => {
    const html = `<nav>Menu here</nav><p>${ARTICLE_BODY}</p><footer>Copyright</footer>`
    const out = removeChrome(html)
    assert.ok(!out.includes('Menu here'))
    assert.ok(!out.includes('Copyright'))
  })

  test('will not delete a wrapper holding most of the page', () => {
    // The safety rail: a chrome-ish class on the article wrapper must not
    // remove the article.
    const html = `<div class="page-header-wrapper"><p>${ARTICLE_BODY}</p></div>`
    assert.ok(removeChrome(html).includes('quick brown fox'))
  })

  test('does not match chrome words inside longer words', () => {
    // "menu" must not fire on "menuscript"; the pattern is word-bounded.
    const html = `<div class="menuscript-body"><p>${ARTICLE_BODY}</p></div>`
    assert.ok(removeChrome(html).includes('quick brown fox'))
  })
})

describe('findMainContent', () => {
  test('prefers <article> when present', () => {
    const html = `<div>sidebar junk</div><article><p>${ARTICLE_BODY}</p></article>`
    const { html: main, found } = findMainContent(html)
    assert.ok(found)
    assert.ok(main.includes('quick brown fox'))
    assert.ok(!main.includes('sidebar junk'))
  })

  test('prefers <main> over a generic div', () => {
    const html = `<div>chrome</div><main><p>${ARTICLE_BODY}</p></main>`
    const { html: main, found } = findMainContent(html)
    assert.ok(found)
    assert.ok(!main.includes('chrome'))
  })

  test('honors role="main"', () => {
    const html = `<div>chrome</div><section role="main"><p>${ARTICLE_BODY}</p></section>`
    const { found, html: main } = findMainContent(html)
    assert.ok(found)
    assert.ok(main.includes('quick brown fox'))
  })

  test('falls back to the densest div when there is no semantic container', () => {
    const html =
      '<div><a href="/1">l1</a><a href="/2">l2</a></div>' +
      `<div class="post"><p>${ARTICLE_BODY}</p></div>`
    const { html: main, found } = findMainContent(html)
    assert.ok(found)
    assert.ok(main.includes('quick brown fox'))
  })

  test('reports not-found for a single continuous document', () => {
    // No container beats the whole body, so the whole body is used and the
    // caller is told extraction did not narrow anything.
    const { found } = findMainContent(`<p>${ARTICLE_BODY}</p>`)
    assert.equal(found, false)
  })

  test('an empty article element does not win', () => {
    const html = `<article></article><div class="post"><p>${ARTICLE_BODY}</p></div>`
    assert.ok(findMainContent(html).html.includes('quick brown fox'))
  })
})

describe('extractLinks', () => {
  const base = 'https://example.com/docs/page'

  test('resolves relative URLs against the page', () => {
    const links = extractLinks('<a href="../other">Other</a>', base)
    assert.equal(links[0].url, 'https://example.com/other')
  })

  test('resolves root-relative and protocol-relative URLs', () => {
    const links = extractLinks(
      '<a href="/root">R</a><a href="//cdn.example.org/x">C</a>',
      base
    )
    assert.equal(links[0].url, 'https://example.com/root')
    assert.equal(links[1].url, 'https://cdn.example.org/x')
  })

  test('marks external links', () => {
    const links = extractLinks(
      '<a href="https://example.com/a">In</a><a href="https://other.org/b">Out</a>',
      base
    )
    assert.equal(links[0].sameSite, true)
    assert.equal(links[1].sameSite, false)
  })

  test('treats www and bare host as the same site', () => {
    const links = extractLinks('<a href="https://www.example.com/a">A</a>', base)
    assert.equal(links[0].sameSite, true)
  })

  test('drops javascript, mailto, tel and data schemes', () => {
    const html =
      '<a href="javascript:x()">js</a><a href="mailto:a@b.c">mail</a>' +
      '<a href="tel:+1">tel</a><a href="data:text/html,x">data</a>'
    assert.equal(extractLinks(html, base).length, 0)
  })

  test('drops pure fragment links and self-links', () => {
    const html = '<a href="#section">Jump</a><a href="https://example.com/docs/page">Self</a>'
    assert.equal(extractLinks(html, base).length, 0)
  })

  test('deduplicates, including links differing only by fragment', () => {
    const html =
      '<a href="/a">One</a><a href="/a">Two</a><a href="/a#frag">Three</a>'
    assert.equal(extractLinks(html, base).length, 1)
  })

  test('drops anchors with no text (icons, empty wrappers)', () => {
    assert.equal(extractLinks('<a href="/a"><img src="i.png"></a>', base).length, 0)
  })

  test('keeps anchor text, tags stripped and entities decoded', () => {
    const links = extractLinks('<a href="/a">Read <b>more</b> &amp; more</a>', base)
    assert.equal(links[0].text, 'Read more & more')
  })

  test('caps the number of links returned', () => {
    const many = Array.from({ length: 200 }, (_, i) => `<a href="/p${i}">Link ${i}</a>`).join('')
    assert.ok(extractLinks(many, base).length <= 60)
  })

  test('survives an unparseable base URL', () => {
    assert.doesNotThrow(() => extractLinks('<a href="/a">A</a>', 'not a url'))
  })
})

describe('decodeEntities / stripTags', () => {
  test('decodes named, numeric and hex entities', () => {
    assert.equal(decodeEntities('a &amp; b &#65; &#x42; &nbsp;c'), 'a & b A B  c')
  })

  test('decodes typographic entities', () => {
    assert.equal(decodeEntities('&ldquo;x&rdquo; &mdash; &hellip;'), '“x” — …')
  })

  test('an out-of-range numeric entity does not throw', () => {
    assert.doesNotThrow(() => decodeEntities('&#1114112;&#-5;'))
  })

  test('stripTags collapses whitespace', () => {
    assert.equal(stripTags('<p>a</p>\n\n  <p>b</p>'), 'a b')
  })
})

describe('extractFromHtml', () => {
  const page = `<html><head><title>My  Title</title></head><body>
    <nav><a href="/home">Home</a></nav>
    <div class="sidebar"><a href="/ads">Sponsored</a></div>
    <article>
      <h1>Heading</h1>
      <p>${ARTICLE_BODY}</p>
      <p>See <a href="/cited">the cited source</a> for detail.</p>
    </article>
    <script>var tracking = 1;</script>
    <footer><a href="/legal">Legal</a></footer>
  </body></html>`

  const result = extractFromHtml(page, 'https://example.com/article')

  test('extracts and normalizes the title', () => {
    assert.equal(result.title, 'My Title')
  })

  test('keeps article prose', () => {
    assert.ok(result.text.includes('quick brown fox'))
    assert.ok(result.text.includes('Heading'))
  })

  test('drops chrome and scripts', () => {
    assert.ok(!result.text.includes('Sponsored'))
    assert.ok(!result.text.includes('tracking'))
    assert.ok(!result.text.includes('Legal'))
  })

  test('reports that a main container was found', () => {
    assert.equal(result.mainContentFound, true)
  })

  test('returns the in-article citation as a followable link', () => {
    assert.ok(result.links.some((l) => l.url === 'https://example.com/cited'))
  })

  test('preserves block structure as newlines', () => {
    assert.ok(result.text.includes('\n'))
  })

  test('handles an empty document without throwing', () => {
    const empty = extractFromHtml('', 'https://example.com')
    assert.equal(empty.text, '')
    assert.equal(empty.title, '')
    assert.deepEqual(empty.links, [])
  })

  test('handles malformed HTML without throwing', () => {
    assert.doesNotThrow(() =>
      extractFromHtml('<div><p>unclosed <a href="/x">link', 'https://example.com')
    )
  })

  test('htmlToText keeps the v0.6 title/text shape', () => {
    const out = htmlToText(page)
    assert.equal(out.title, 'My Title')
    assert.ok(out.text.includes('quick brown fox'))
  })
})
