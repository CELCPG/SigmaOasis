import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'dompurify'

import { latexToPlainText } from './mathPlaintext'

// Register only common languages — the full highlight.js bundle is ~1 MB.
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('css', css)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

/**
 * Markdown → sanitized HTML for assistant messages. Code blocks are
 * syntax-highlighted and wrapped with a header row (language label + Copy
 * button); the copy click is delegated in MessageBubble.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code(code: string, infostring: string | undefined): string {
      const requested = (infostring ?? '').trim().split(/\s+/)[0]
      const language = requested && hljs.getLanguage(requested) ? requested : 'plaintext'
      let highlighted: string
      try {
        highlighted = hljs.highlight(code, { language }).value
      } catch {
        highlighted = escapeHtml(code)
      }
      return (
        `<div class="code-block">` +
        `<div class="code-header"><span>${escapeHtml(language)}</span>` +
        `<button type="button" class="code-copy-btn">Copy</button></div>` +
        `<pre><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre>` +
        `</div>`
      )
    }
  }
})

export function renderMarkdown(markdown: string): string {
  // Models often wrap numbers and units in TeX ($374^\circ\text{C}$); the
  // renderer has no math engine, so rewrite it to plain text first.
  const html = marked.parse(latexToPlainText(markdown), { async: false }) as string
  return DOMPurify.sanitize(html)
}

/**
 * Split a still-streaming reply into a stable prefix and a live tail, so the
 * prefix can be parsed once and memoized while only the growing tail is
 * re-parsed per flush. Without the split, a streaming reply re-parsed,
 * re-highlighted and re-sanitized its entire accumulated text on every
 * repaint — O(n²) over the reply, and worst exactly on long code answers.
 *
 * The split lands on a blank line (a block boundary for everything but
 * tables, which contain no blank lines and so fall wholly into the tail) and
 * never inside an open ``` fence — parsing half a fence turns code into
 * prose. While a fence is open the split retreats to the blank line before
 * it, so the live tail is the open code block and nothing more. Rendering
 * prefix and tail separately can differ from a whole-parse in corner cases
 * (reference links defined early and used late); any such imperfection is
 * transient, because the finished message is always parsed whole.
 */
export function splitStreamingMarkdown(markdown: string): [stable: string, live: string] {
  let idx = markdown.lastIndexOf('\n\n')
  while (idx >= 0) {
    const stable = markdown.slice(0, idx + 2)
    const fences = stable.match(/```/g)
    if (!fences || fences.length % 2 === 0) return [stable, markdown.slice(idx + 2)]
    // Boundary sits inside an open fence — retreat to before its opening.
    idx = markdown.lastIndexOf('\n\n', markdown.lastIndexOf('```', idx) - 1)
  }
  return ['', markdown]
}
