'use strict'

const { readConfig } = require('./config')

const DEFAULT_PORT = 3000

/** The port to listen on: the config's `port`, or 3000 when it sets none. */
async function loadPort(path) {
  const config = await readConfig(path)
  const port = config.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Bad port in ${path}: ${port}`)
  return port
}

module.exports = { loadPort, DEFAULT_PORT }
