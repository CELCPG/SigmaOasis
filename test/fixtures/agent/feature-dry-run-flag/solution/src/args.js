'use strict'

/**
 * Command-line options for `bundle`:
 *
 *   bundle [--verbose|-v] [--dry-run|-n] [--out|-o <folder> | --out=<folder>] <file> [file ...]
 */
function parseArgs(argv) {
  const opts = { out: 'dist', verbose: false, dryRun: false, files: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--verbose' || a === '-v') opts.verbose = true
    else if (a === '--dry-run' || a === '-n') opts.dryRun = true
    else if (a === '--out' || a === '-o') {
      const v = argv[++i]
      if (!v) throw new Error(`${a} needs a folder`)
      opts.out = v
    } else if (a.startsWith('--out=')) {
      const v = a.slice('--out='.length)
      if (!v) throw new Error('--out needs a folder')
      opts.out = v
    } else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`)
    else opts.files.push(a)
  }
  return opts
}

module.exports = { parseArgs }
