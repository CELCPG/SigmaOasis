// ---- Static-first, render-on-failure ----------------------------------------

/** Below this much extracted text, a page probably did not render server-side. */
const THIN_TEXT_CHARS = 500

/**
 * Markers of a page whose content arrives only after scripts run. Matched
 * against the *raw HTML*, since by definition the extracted text is empty.
 */
const JS_SHELL_MARKERS = [
  /<div[^>]+id=["'](?:root|app|__next|__nuxt|application)["']/i,
  /<noscript>[^<]*(?:enable|requires?)\s+JavaScript/i,
  /window\.__(?:NUXT|NEXT_DATA|INITIAL_STATE)__/i,
  /\bng-app\b|\bdata-reactroot\b|\bv-cloak\b/i
]

/**
 * Should this page be re-read with the headless renderer?
 *
 * Static-first is deliberate and is as much a privacy decision as a performance
 * one: a plain fetch executes nothing and contacts exactly one host, so it is
 * the cheaper and safer path and should handle the majority of pages. The
 * renderer is escalated to only when the static result is visibly inadequate.
 *
 * Exported for tests — the decision is worth asserting directly.
 */
export function shouldRender(
  kind: 'html' | 'text' | 'pdf',
  extractedText: string,
  rawHtml: string
): { render: boolean; reason?: string } {
  // A PDF or plain-text response has no scripts to run; rendering cannot help.
  if (kind !== 'html') return { render: false }

  const length = extractedText.trim().length
  if (length >= THIN_TEXT_CHARS) return { render: false }

  const marker = JS_SHELL_MARKERS.find((re) => re.test(rawHtml))
  if (marker) {
    return { render: true, reason: 'the page looks like a client-rendered app shell' }
  }
  if (length === 0) {
    return { render: true, reason: 'the static fetch produced no text at all' }
  }
  return {
    render: true,
    reason: `the static fetch produced only ${length} characters of text`
  }
}
