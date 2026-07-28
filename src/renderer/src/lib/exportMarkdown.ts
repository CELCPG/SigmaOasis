import type { Conversation } from '../types'

/**
 * Renders a conversation as a clean Markdown transcript for export.
 * Image attachments are noted by name (their data URLs never leave the app);
 * tool calls are summarized inline so the transcript stays readable.
 */
export function conversationToMarkdown(convo: Conversation): string {
  const lines: string[] = [
    `# ${convo.title}`,
    '',
    `_Exported from FunkinAI · ${new Date(convo.updatedAt).toLocaleString()}_`,
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
        lines.push(
          `> 🔧 \`${tc.name}\` — ${tc.status}${tc.result ? `: ${tc.result.slice(0, 200)}` : ''}`,
          ''
        )
      }
      if (m.content) lines.push(m.content, '')
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
