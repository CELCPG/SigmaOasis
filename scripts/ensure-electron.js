// Make sure the Electron binary is present under node_modules/electron/dist.
//
// Since Electron 42 the `electron` npm package no longer downloads its binary
// in a postinstall script; it fetches on first `npx electron` instead. Every
// script in this repo that runs the app for real (the check suites, the evals,
// the head-to-head driver, the pack builder) reaches the binary by path, and
// each one *skips* when it is missing — so a fresh `npm install` would leave
// CI green with the Electron suites silently not run. This does the download
// eagerly, at install time, the way the package itself used to.
//
// No-op when the binary is already there. Exit code is the installer's, so a
// failed download is visible; package.json's `|| true` keeps an offline
// `npm install` from failing outright (the first `npm run dev` retries).
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const pkg = path.join(__dirname, '..', 'node_modules', 'electron')
const pathFile = path.join(pkg, 'path.txt')
if (fs.existsSync(pathFile)) {
  const exe = path.join(pkg, 'dist', fs.readFileSync(pathFile, 'utf-8').trim())
  if (fs.existsSync(exe)) process.exit(0)
}
const r = spawnSync(process.execPath, [path.join(pkg, 'install.js')], { stdio: 'inherit' })
process.exit(r.status ?? 1)
