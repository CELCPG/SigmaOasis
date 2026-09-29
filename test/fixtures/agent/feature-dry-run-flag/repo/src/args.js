'use strict'

/**
 * Command-line options for `bundle`:
 *
 *   bundle [--verbose|-v] [--out|-o <folder>] <file> [file ...]
 */
function parseArgs(argv) {
  const opts = { out: 'dist', verbose: false, files: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--verbose' || a === '-v') opts.verbose = true
    else if (a === '--out' || a === '-o') {
      const v = argv[++i]
      if (!v) throw new Error(`${a} needs a folder`)
      opts.out = v
    } else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`)
    else opts.files.push(a)
  }
  return opts
}

module.exports = { parseArgs }
