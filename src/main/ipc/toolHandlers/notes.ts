import { readNotes, writeNotes } from '../store'
import { addToMemory } from '../memory'
import { truncate } from './types'
import type { ToolHandler } from './types'

/** Local notes: create_note, list_notes, read_note. Notes auto-index into long-term memory. */

const createNote: ToolHandler = async (args) => {
  const title = String(args.title ?? '').trim()
  if (!title) return { ok: false, error: 'Note title is required.' }
  const content = String(args.content ?? '')
  const notes = await readNotes()
  const existing = notes.findIndex((n) => n.title === title)
  const note = { title, content, createdAt: Date.now() }
  if (existing >= 0) notes[existing] = note
  else notes.push(note)
  await writeNotes(notes)
  // Auto-index into long-term memory (best effort — never fails the note).
  void addToMemory(`note: ${title}`, content).catch(() => undefined)
  return { ok: true, output: `Note "${title}" saved.` }
}

const listNotes: ToolHandler = async () => {
  const notes = await readNotes()
  return {
    ok: true,
    output: notes.length > 0 ? notes.map((n) => `- ${n.title}`).join('\n') : '(no notes saved)'
  }
}

const readNote: ToolHandler = async (args) => {
  const title = String(args.title ?? '')
  const notes = await readNotes()
  const note =
    notes.find((n) => n.title === title) ??
    notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
  return note
    ? { ok: true, output: truncate(note.content) }
    : { ok: false, error: `No note titled "${title}".` }
}

export const noteHandlers = {
  create_note: createNote,
  list_notes: listNotes,
  read_note: readNote
} satisfies Record<string, ToolHandler>
