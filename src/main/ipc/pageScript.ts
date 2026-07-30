/**
 * The extraction script injected into a rendered page's isolated world.
 *
 * Kept as a string, and kept separate from render.ts, for two reasons: it runs in
 * a browser context rather than the main process (so it must not be bundled or
 * type-shared with main-process code), and having it in one file makes what we
 * inject into a hostile document auditable at a glance.
 *
 * It only reads the DOM. It sends nothing, sets nothing, and returns a plain
 * JSON-serializable object.
 *
 * ## Hidden-text stripping
 *
 * The main reason a real DOM is worth having. Text that is invisible to a human
 * reader — `display:none`, `opacity:0`, zero font size, screen-reader clipping,
 * positioned off-canvas — is where prompt injections hide, precisely because a
 * reader reviewing the page never sees it. `getComputedStyle` is the only
 * reliable way to detect it; a regex over raw HTML cannot, since the styling may
 * come from an external stylesheet or a class defined anywhere.
 *
 * So the rendered path is *safer* against injection than the static path, not
 * riskier. The count of dropped nodes is reported so the user can see it happened.
 */
export const PAGE_EXTRACTION_SCRIPT = String.raw`
(function () {
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1,
    OBJECT: 1, EMBED: 1, VIDEO: 1, AUDIO: 1, SELECT: 1, OPTION: 1, TEXTAREA: 1,
    NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, FORM: 1, BUTTON: 1
  };

  var BLOCK_TAGS = {
    P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, LI: 1, UL: 1, OL: 1, DL: 1,
    DD: 1, DT: 1, TR: 1, TABLE: 1, THEAD: 1, TBODY: 1, BLOCKQUOTE: 1, PRE: 1,
    FIGURE: 1, FIGCAPTION: 1, BR: 1, HR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1
  };

  var CHROME_RE = new RegExp(
    '\\b(nav|navbar|navigation|menu|sidebar|breadcrumb|footer|header|masthead|' +
    'banner|cookie|consent|gdpr|newsletter|subscribe|signup|social|share|sharing|' +
    'comment|comments|disqus|promo|advert|advertisement|sponsored|related|' +
    'recommend|trending|popular|paywall|modal|popup|overlay|toolbar|pagination|' +
    'pager|skip-link|screen-reader|sr-only|visually-hidden)\\b', 'i'
  );

  var hiddenTextRemoved = 0;

  /** Is this element invisible to a human reader? */
  function isHidden(el) {
    var cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
    if (!cs) return false;

    if (cs.display === 'none') return true;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    if (parseFloat(cs.opacity) === 0) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;

    // Text scaled to nothing.
    var fs = parseFloat(cs.fontSize);
    if (!isNaN(fs) && fs < 1) return true;

    // The classic screen-reader-only clipping patterns.
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clip === 'rect(1px, 1px, 1px, 1px)') return true;
    if (cs.clipPath === 'inset(50%)' || cs.clipPath === 'inset(100%)') return true;

    // Pushed off the canvas, or collapsed to nothing with overflow hidden.
    var indent = parseFloat(cs.textIndent);
    if (!isNaN(indent) && indent <= -999) return true;
    if (cs.overflow === 'hidden') {
      var w = parseFloat(cs.width), h = parseFloat(cs.height);
      if ((!isNaN(w) && w <= 1) || (!isNaN(h) && h <= 1)) return true;
    }
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      var left = parseFloat(cs.left), top = parseFloat(cs.top);
      if ((!isNaN(left) && left <= -9999) || (!isNaN(top) && top <= -9999)) return true;
    }
    return false;
  }

  function isChrome(el) {
    var id = el.id || '';
    var cls = typeof el.className === 'string' ? el.className : '';
    if (!id && !cls) return false;
    return CHROME_RE.test(id + ' ' + cls);
  }

  /**
   * Would this element be excluded by anything up its ancestor chain?
   *
   * Needed for links, which are collected by querySelectorAll rather than by the
   * tree walk, so they get none of the walk's exclusions for free. Checking the
   * chain matters twice over: it keeps the rendered path's link list consistent
   * with the static path (which builds links from chrome-stripped HTML), and it
   * catches an anchor inside a display:none parent — getComputedStyle on the
   * anchor itself still reports "inline", so checking only the element misses it.
   */
  function isExcluded(el) {
    var n = el;
    var depth = 0;
    while (n && n.nodeType === 1 && depth < 80) {
      if (SKIP_TAGS[n.tagName]) return true;
      if (isChrome(n)) return true;
      if (isHidden(n)) return true;
      n = n.parentNode;
      depth++;
    }
    return false;
  }

  var out = [];

  function walk(node, depth) {
    if (depth > 80) return;

    if (node.nodeType === 3) {
      var t = node.nodeValue;
      if (t && t.trim()) out.push(t);
      return;
    }
    if (node.nodeType !== 1) return;

    var tag = node.tagName;
    if (SKIP_TAGS[tag]) return;

    if (isHidden(node)) {
      var len = (node.textContent || '').trim().length;
      if (len) hiddenTextRemoved += len;
      return;
    }
    if (isChrome(node)) return;

    var block = !!BLOCK_TAGS[tag];
    if (block) out.push('\n');
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    if (block) out.push('\n');
  }

  /** Prefer a semantic content container when the page offers one. */
  function contentRoot() {
    var candidates = []
      .concat(Array.prototype.slice.call(document.querySelectorAll('main')))
      .concat(Array.prototype.slice.call(document.querySelectorAll('article')))
      .concat(Array.prototype.slice.call(document.querySelectorAll('[role="main"]')));
    var best = null, bestLen = 0;
    for (var i = 0; i < candidates.length; i++) {
      var len = (candidates[i].textContent || '').trim().length;
      if (len > bestLen) { best = candidates[i]; bestLen = len; }
    }
    // Require it to hold real substance before trusting it over the body.
    if (best && bestLen > 200) return best;
    return document.body;
  }

  var root = contentRoot();
  if (root) walk(root, 0);

  var text = out.join('')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line.length > 0; })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  // Links come from the whole document, not just the content root: a page's
  // useful references (citations, "see also", docs pagination) often sit just
  // outside the article body. Chrome and hidden containers are still excluded, so
  // this matches what the static path returns for the same page.
  var links = [];
  var seen = {};
  var here = location.href.split('#')[0];
  var anchors = document.querySelectorAll('a[href]');
  for (var j = 0; j < anchors.length && links.length < 60; j++) {
    var a = anchors[j];
    var href = a.href;
    if (!href) continue;
    if (!/^https?:/i.test(href)) continue;
    var clean = href.split('#')[0];
    if (!clean || clean === here || seen[clean]) continue;
    if (isExcluded(a)) continue;
    var label = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!label) continue;
    seen[clean] = 1;
    var sameSite = false;
    try {
      var strip = function (h) { return h.replace(/^www\./i, '').toLowerCase(); };
      sameSite = strip(new URL(clean).host) === strip(location.host);
    } catch (e) { sameSite = false; }
    links.push({ url: clean, text: label, sameSite: sameSite });
  }

  return {
    title: (document.title || '').replace(/\s+/g, ' ').trim(),
    text: text,
    links: links,
    hiddenTextRemoved: hiddenTextRemoved
  };
})()
`
