'use strict'

const { readConfig } = require('./config')

const DEFAULT_PORT = 3000

/** The port to listen on: the config's `port`, or 3000 when it sets none. callback(err, port). */
function loadPort(path, callback) {
  readConfig(path, (err, config) => {
    if (err) return callback(err)
    const port = config.port ?? DEFAULT_PORT
    if (!Number.isInteger(port) || port < 1 || port > 65535) return callback(new Error(`Bad port in ${path}: ${port}`))
    callback(null, port)
  })
}

module.exports = { loadPort, DEFAULT_PORT }
