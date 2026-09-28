'use strict'

const config = require('./config')
const { withRetry } = require('./retry')

/** Split a file's bytes into the chunks the server accepts. */
function chunks(bytes) {
  const out = []
  for (let i = 0; i < bytes.length; i += config.CHUNK_BYTES) out.push(bytes.subarray(i, i + config.CHUNK_BYTES))
  return out
}

/** Upload every chunk of a file with `send(chunk, index)`, retrying each as configured. */
async function uploadFile(bytes, send, sleep) {
  const parts = chunks(bytes)
  for (let i = 0; i < parts.length; i++) {
    await withRetry(() => send(parts[i], i), { attempts: config.MAX_UPLOAD_RETRIES, baseMs: config.RETRY_BASE_MS, sleep })
  }
  return parts.length
}

module.exports = { uploadFile, chunks }
