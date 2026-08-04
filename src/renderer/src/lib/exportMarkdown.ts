import type { Conversation } from '../types'

/**
 * Per tool call, in an exported transcript. Generous rather than tidy: the
 * export is the only artifact anyone can audit a reply against after the fact,
 * so the evidence has to survive it.
 */
const MAX_RESULT_CHARS = 6000
const MAX_ARGS_CHARS = 500

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated, ${text.length} chars total]` : text
}

/**
 * A fence longer than any run of backticks inside the content, so a tool
 * result that itself contains code blocks cannot break out of its block.
 */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Renders a conversation as a clean Markdown transcript for export.
 * Image attachments are noted by name (their data URLs never leave the app);
 * tool calls are rendered with their arguments and full result so the
 * transcript can be checked, not just read.
 */
export function conversationToMarkdown(convo: Conversation): string {
  const lines: string[] = [
    `# ${convo.title}`,
    '',
    `_Exported from Sigma Oasis · ${new Date(convo.updatedAt).toLocaleString()}_`,
    ''
  ]

  for (const m of convo.messages) {
    if (m.role === 'user') {
      lines.push('## 🧑 You', '')
      const files = (m.attachments ?? []).filter((a) => a.kind === 'file')
      const images = (m.attachments ?? []).filter((a) => a.kind === 'image')
      for (const a of [...images, ...files]) lines.push(`> 📎 ${a.name}`, '')
      if (m.content) lines.push(m.content, '')
    } else {
      const who = m.roleName ? `${m.roleName} (${m.modelId})` : m.modelId || 'Assistant'
      lines.push(`## 🤖 ${who}`, '')
      for (const tc of m.toolCalls ?? []) {
        lines.push(`> 🔧 \`${tc.name}\` — ${tc.status}`, '')
        const args = Object.keys(tc.args ?? {}).length > 0 ? JSON.stringify(tc.args) : ''
        if (args) lines.push(`> arguments: \`${truncate(args, MAX_ARGS_CHARS)}\``, '')
        if (tc.result) {
          // Fenced, not inline-truncated. A transcript exists to be audited,
          // and through v1.3 every tool result was cut at 200 characters —
          // which reliably removed the search results a reply was built on,
          // leaving no way to tell a grounded answer from an invented one.
          const body = truncate(tc.result, MAX_RESULT_CHARS)
          const fence = fenceFor(body)
          lines.push(fence, body, fence, '')
        }
      }
      if (m.content) lines.push(m.content, '')
      if (m.unverified) {
        lines.push('> ⚠️ Answered from model memory — no sources consulted.', '')
      }
      if (m.grounding) {
        // The whole point of the check is that it survives to where someone
        // can act on it; an export that drops it is the same failure as the
        // truncation above.
        const g = m.grounding
        const parts: string[] = []
        if (g.figures.length > 0) parts.push(`figures not in tool output: ${g.figures.join(', ')}`)
        if (g.links.length > 0) parts.push(`links not in tool output: ${g.links.join(', ')}`)
        lines.push(
          `> ⚠️ Not backed by this turn's tools (checked against ${g.checkedAgainst.join(', ')}) — ${parts.join('; ')}.`,
          ''
        )
      }
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
