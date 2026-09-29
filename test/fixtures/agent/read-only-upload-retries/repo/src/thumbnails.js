'use strict'

const config = require('./config')
const { withRetry } = require('./retry')

/** Ask the image service for every thumbnail size; a failed size is retried with the default policy. */
async function requestThumbnails(photoId, request) {
  const done = []
  for (const size of config.THUMBNAIL_SIZES) {
    done.push(await withRetry(() => request(photoId, size)))
  }
  return done
}

module.exports = { requestThumbnails }
