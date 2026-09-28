'use strict'

/**
 * Run `fn` until it resolves, waiting base, 2·base, 4·base … between tries.
 * `attempts` counts the retries after the first try; 3 unless the caller says.
 */
async function withRetry(fn, { attempts = 3, baseMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastError
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn(i)
    } catch (err) {
      lastError = err
      if (i < attempts) await sleep(baseMs * 2 ** i)
    }
  }
  throw lastError
}

module.exports = { withRetry }
