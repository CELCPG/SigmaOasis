'use strict'

/**
 * Minutes in a duration written like "1h30m", "2h" or "45m".
 * Throws for anything else, including an empty string.
 */
function parseDuration(text) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(String(text).trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) throw new Error(`Not a duration: ${JSON.stringify(text)}`)
  return Number(m[1]) * 60 + Number(m[2])
}

/** 95 → "1h35m", 60 → "1h", 5 → "5m". */
function formatDuration(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h ? `${h}h` : ''}${m || !h ? `${m}m` : ''}`
}

module.exports = { parseDuration, formatDuration }
