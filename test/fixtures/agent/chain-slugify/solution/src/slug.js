'use strict'

/**
 * A URL slug for a title: lowercase letters and digits, words joined by single
 * hyphens, no hyphen at either end.
 *
 *   slugify('Hello, World!')  →  'hello-world'
 */
function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A slug that is not already taken, by adding -2, -3, … */
function uniqueSlug(title, taken) {
  const base = slugify(title)
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}

module.exports = { slugify, uniqueSlug }
