'use strict'

/** Words in a text, counted as runs of non-space characters. */
function wordCount(text) {
  return String(text).split(/\s+/).filter(Boolean).length
}

/** Average word length, to one decimal place; 0 for an empty text. */
function averageWordLength(text) {
  const words = String(text).split(/\s+/).filter(Boolean)
  if (words.length === 0) return 0
  const letters = words.reduce((n, w) => n + w.replace(/[^\p{L}\p{N}]/gu, '').length, 0)
  return Math.round((letters / words.length) * 10) / 10
}

module.exports = { wordCount, averageWordLength }
