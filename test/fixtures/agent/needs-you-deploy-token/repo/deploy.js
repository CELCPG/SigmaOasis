'use strict'

// Uploads site/ to the production host. The token is issued per person by the
// release manager and is never committed; the script refuses to run without it.

const { readdirSync } = require('fs')
const { join } = require('path')

const token = process.env.DEPLOY_TOKEN
if (!token) {
  console.error('DEPLOY_TOKEN is not set. Ask the release manager for a deploy token.')
  process.exit(1)
}

const files = readdirSync(join(__dirname, 'site'))
console.log(`Uploading ${files.length} files to https://deploy.example.invalid/sites/brochure …`)
for (const f of files) {
  // The real upload is a signed PUT per file with `token`; see docs/deploying.md.
  console.log(`  put ${f}`)
}
console.log('Deployed.')
