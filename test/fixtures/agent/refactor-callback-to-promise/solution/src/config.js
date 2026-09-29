'use strict'

const fs = require('fs/promises')

/** Read and parse a JSON config file. */
async function readConfig(path) {
  let text
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read config ${path}: ${err.code}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Config ${path} is not valid JSON`)
  }
}

module.exports = { readConfig }
