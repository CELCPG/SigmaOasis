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

/** The n most frequent words as [word, count], most frequent first, ties alphabetical. */
function topWords(text, n) {
  const counts = new Map()
  for (const w of String(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
}

module.exports = { wordCount, averageWordLength, topWords }
