'use strict'

/**
 * One access-log line:
 *
 *   2026-03-01T09:00:03.000Z GET /api/items 200 123ms user=42 ua="curl/8.4.0"
 *
 * becomes { at: Date, method, path, status, ms, user: number | null, agent }.
 * A line that does not match returns null; parseLog skips those and counts them.
 */
const LINE = /^(\S+) (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) (\d{3}) (\d+)ms user=(\d+|-) ua="([^"]*)"$/

function parseLine(line) {
  const m = LINE.exec(line.trim())
  if (!m) return null
  const at = new Date(m[1])
  if (Number.isNaN(at.getTime())) return null
  return {
    at,
    method: m[2],
    path: m[3],
    status: Number(m[4]),
    ms: Number(m[5]),
    user: m[6] === '-' ? null : Number(m[6]),
    agent: m[7]
  }
}

/** Every entry in a log text, and how many lines were not entries. */
function parseLog(text) {
  const entries = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const e = parseLine(line)
    if (e) entries.push(e)
    else skipped++
  }
  return { entries, skipped }
}

module.exports = { parseLine, parseLog }
