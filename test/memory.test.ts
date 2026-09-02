import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'fs'
import { join } from 'path'
import { load, resetState, testUserDataDir } from './harness'

const memory = load<typeof import('../src/main/ipc/memory')>('memory')

const { addToMemory, deleteFromMemory, searchMemory, MEMORY_SCORE_FLOOR } = memory

beforeEach(async () => {
  resetState()
  await fs.rm(join(testUserDataDir(), 'memory.json'), { force: true })
  await fs.mkdir(testUserDataDir(), { recursive: true })
})

describe('searchMemory relevance floor', () => {
  test('an unrelated query recalls nothing, even with memories stored', async () => {
    // This is the first-turn ghost-context bug: without a floor, top-K always
    // returns *something*, and random memories injected into the system prompt
    // can pull the model off the user's actual question.
    await addToMemory('garage notes', 'The car needs an oil change soon. The vehicle is due.')
    const results = await searchMemory('quantum encryption latency', 3)
    assert.equal(results.length, 0)
  })

  test('a relevant query passes the floor and is returned', async () => {
    await addToMemory('garage notes', 'The car needs an oil change soon. The vehicle is due.')
    const results = await searchMemory('when does the car need service', 3)
    assert.equal(results.length, 1)
    assert.equal(results[0]!.source, 'garage notes')
    assert.ok(results[0]!.score >= MEMORY_SCORE_FLOOR)
  })

  test('minScore 0 restores raw top-K ranking for callers that want it', async () => {
    await addToMemory('garage notes', 'The car needs an oil change soon. The vehicle is due.')
    const results = await searchMemory('quantum encryption latency', 3, 0)
    assert.equal(results.length, 1)
    assert.ok(results[0]!.score < MEMORY_SCORE_FLOOR)
  })

  test('the floor applies per chunk: strong neighbours do not rescue weak ones', async () => {
    await addToMemory('garage notes', 'The car needs an oil change soon. The vehicle is due.')
    await addToMemory('physics reading', 'Quantum encryption research notes with latency measurements.')
    const results = await searchMemory('car oil service', 5)
    assert.equal(results.length, 1)
    assert.equal(results[0]!.source, 'garage notes')
    assert.ok(results[0]!.score >= MEMORY_SCORE_FLOOR)
  })

  test('empty memory returns nothing rather than throwing', async () => {
    const results = await searchMemory('anything at all', 3)
    assert.deepEqual(results, [])
  })
})

describe('memory store round-trip', () => {
  test('add replaces the same source instead of duplicating it', async () => {
    await addToMemory('notes', 'The car is red.')
    await addToMemory('notes', 'The car is blue.')
    const results = await searchMemory('car', 10, 0)
    assert.equal(results.length, 1)
    assert.match(results[0]!.text, /blue/)
  })

  test('delete removes every chunk of a source', async () => {
    await addToMemory('notes', 'The car is red.')
    const { removed } = await deleteFromMemory('notes')
    assert.equal(removed, 1)
    const results = await searchMemory('car', 10, 0)
    assert.deepEqual(results, [])
  })
})
describe('memory store bound (v2.4)', () => {
  test('a save that would cross the cap is refused and the store is untouched', async () => {
    resetState()
    const memory = load<typeof import('../src/main/ipc/memory')>('memory')
    const stats = async (): Promise<{ totalChunks: number; maxChunks: number }> =>
      (await memory.memoryStats()) as { totalChunks: number; maxChunks: number }
    await memory.addToMemory('notes', 'The car is red.', 10)
    const before = (await stats()).totalChunks
    assert.ok(before >= 1)
    await assert.rejects(
      () => memory.addToMemory('manual', 'A second source that will not fit.', before),
      (err: unknown) => err instanceof memory.MemoryFullError && /Memory is full/.test((err as Error).message)
    )
    assert.equal((await stats()).totalChunks, before)
    assert.equal((await stats()).maxChunks, memory.MAX_MEMORY_CHUNKS)
  })

  test('replacing a source counts what it frees before what it adds', async () => {
    resetState()
    const memory = load<typeof import('../src/main/ipc/memory')>('memory')
    const stats = async (): Promise<{ totalChunks: number }> => (await memory.memoryStats()) as { totalChunks: number }
    await memory.addToMemory('notes', 'The car is red.', 10)
    const before = (await stats()).totalChunks
    // The same source again at a cap equal to the current count: the old chunks
    // leave first, so the new ones fit.
    await memory.addToMemory('notes', 'The car is blue.', before)
    assert.equal((await stats()).totalChunks, before)
  })
})
