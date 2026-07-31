import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'fs'
import { join } from 'path'
import { load, resetState, testUserDataDir } from './harness'

const memory = load<typeof import('../src/main/ipc/memory')>('memory')

const { addToMemory, searchMemory } = memory

beforeEach(async () => {
  resetState()
  await fs.rm(join(testUserDataDir(), 'memory.json'), { force: true })
  await fs.mkdir(testUserDataDir(), { recursive: true })
  await addToMemory('garage notes', 'The car needs an oil change soon. The vehicle is due.')
  await addToMemory('physics reading', 'Quantum encryption research notes with latency measurements.')
})

describe('per-conversation memory scoping (v0.9)', () => {
  test('null scope searches every source (the pre-0.9 behavior)', async () => {
    // minScore 0 = raw ranking: every eligible chunk comes back, so an
    // unscoped search sees both sources even though only one is about cars.
    const results = await searchMemory('car', 10, 0, null)
    assert.equal(results.length, 2)
    assert.deepEqual(
      results.map((r) => r.source).sort(),
      ['garage notes', 'physics reading']
    )
  })

  test('a source list recalls only from those sources', async () => {
    const scoped = await searchMemory('car', 10, 0, ['physics reading'])
    // The car note scores higher for "car" but is outside the scope — for
    // this conversation it does not exist.
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0]!.source, 'physics reading')

    const garage = await searchMemory('car', 10, 0, ['garage notes'])
    assert.equal(garage.length, 1)
    assert.equal(garage[0]!.source, 'garage notes')
  })

  test('an empty scope is a legitimate "no memory for this chat"', async () => {
    const results = await searchMemory('car', 10, 0, [])
    assert.deepEqual(results, [])
  })

  test('a scope naming unknown sources returns empty rather than throwing', async () => {
    const results = await searchMemory('car', 10, 0, ['does-not-exist'])
    assert.deepEqual(results, [])
  })

  test('scoping composes with the relevance floor', async () => {
    // Unrelated query, unscoped: nothing passes the floor. Scoping must not
    // weaken that — an allowed source with no relevant chunk stays silent.
    const results = await searchMemory('quantum encryption latency', 3, undefined, [
      'garage notes'
    ])
    assert.deepEqual(results, [])
  })
})
