'use strict'

const fs = require('fs')

/** Read and parse a JSON config file: callback(err, config). */
function readConfig(path, callback) {
  fs.readFile(path, 'utf8', (err, text) => {
    if (err) return callback(new Error(`Cannot read config ${path}: ${err.code}`))
    let config
    try {
      config = JSON.parse(text)
    } catch {
      return callback(new Error(`Config ${path} is not valid JSON`))
    }
    callback(null, config)
  })
}

module.exports = { readConfig }
