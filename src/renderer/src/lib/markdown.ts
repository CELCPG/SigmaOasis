import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'dompurify'

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
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html)
}
