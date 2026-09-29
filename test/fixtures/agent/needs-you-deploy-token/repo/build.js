'use strict'

// Copies the pages into site/ with the site's header and footer around each.

const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const pages = join(__dirname, 'pages')
const site = join(__dirname, 'site')
const wrap = (body) => `<!doctype html><header>Brochure</header>${body}<footer>© Brochure</footer>`

mkdirSync(site, { recursive: true })
for (const f of readdirSync(pages)) {
  writeFileSync(join(site, f), wrap(readFileSync(join(pages, f), 'utf8')))
}
console.log('Built.')
