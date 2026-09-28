#!/usr/bin/env node
'use strict'

const { parseArgs } = require('./args')

try {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.files.length === 0) throw new Error('Name at least one file to bundle.')
  if (opts.verbose) console.log(`bundling ${opts.files.length} file(s) into ${opts.out}/`)
  // The bundler proper lives in another package; this is its front door.
} catch (err) {
  console.error(err.message)
  process.exit(2)
}
