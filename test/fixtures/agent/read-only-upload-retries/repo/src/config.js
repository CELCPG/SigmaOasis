'use strict'

/** Tuning for the uploader. Change these here, not at the call sites. */
module.exports = {
  CHUNK_BYTES: 4 * 1024 * 1024,
  PARALLEL_CHUNKS: 3,
  MAX_UPLOAD_RETRIES: 5,
  RETRY_BASE_MS: 400,
  THUMBNAIL_SIZES: [160, 640, 1280]
}
