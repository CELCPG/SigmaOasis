// Bundle the `sigma` CLI (src/cli/sigma.ts) into one file, out/cli/sigma.js.
//
// One file with no dependencies, because it has to run from anywhere: on the
// system's Node for a developer (`node out/cli/sigma.js`), and in an installed
// app on the app's own runtime (ELECTRON_RUN_AS_NODE), from resources/cli/,
// where no node_modules sit beside it. esbuild is already in the tree (vite
// brings it); nothing is added to the dependencies for this.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['src/cli/sigma.ts'],
  outfile: 'out/cli/sigma.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // The runtime every install has: Electron 44's Node (24), and any Node 20+.
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  define: { __SIGMA_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning'
})
console.log(`built out/cli/sigma.js (sigma ${pkg.version})`)
