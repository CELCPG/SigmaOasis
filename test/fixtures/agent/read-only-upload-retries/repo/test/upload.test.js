const { test } = require('node:test')
const assert = require('node:assert/strict')
const { uploadFile } = require('../src/upload')

test('a chunk that fails twice still uploads', async () => {
  let calls = 0
  const send = async () => {
    calls++
    if (calls < 3) throw new Error('flaky network')
  }
  assert.equal(await uploadFile(Buffer.alloc(10), send, async () => {}), 1)
  assert.equal(calls, 3)
})
