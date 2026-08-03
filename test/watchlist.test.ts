import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'fs'
import { join } from 'path'
import { load, resetState, testUserDataDir } from './harness'

const watchlist = load<typeof import('../src/main/ipc/watchlist')>('watchlist')

/**
 * The watchlist is the part of this feature that is better *because* it is
 * local: every commercial price tracker works by holding this list on a server.
 * These tests pin the two things that make the local version trustworthy —
 * tracking parameters never enter it, and a failed check appends nothing
 * rather than a fabricated point.
 */

const file = (): string => join(testUserDataDir(), 'watchlist.json')

async function clear(): Promise<void> {
  await fs.rm(file(), { force: true })
}

beforeEach(async () => {
  resetState()
  await clear()
})

after(clear)

describe('addWatch', () => {
  test('stores an entry with a tracking-free URL', async () => {
    const added = await watchlist.addWatch({
      url: 'https://shop.example/p/1?tag=aff-20&utm_source=x&color=red',
      name: 'Laptop'
    })
    assert.equal(added.ok, true)
    assert.equal(added.entry?.url, 'https://shop.example/p/1?color=red')
    assert.equal(added.entry?.name, 'Laptop')
    assert.deepEqual(added.entry?.history, [])
  })

  test('re-adding updates the target instead of duplicating', async () => {
    await watchlist.addWatch({ url: 'https://shop.example/p/1', name: 'A', targetPrice: 100 })
    await watchlist.addWatch({ url: 'https://shop.example/p/1', targetPrice: 90 })
    const entries = await watchlist.readWatchlist()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].targetPrice, 90)
  })

  test('the same product with different tracking tags is one entry', async () => {
    await watchlist.addWatch({ url: 'https://shop.example/p/1?tag=a' })
    await watchlist.addWatch({ url: 'https://shop.example/p/1?utm_source=b' })
    assert.equal((await watchlist.readWatchlist()).length, 1)
  })

  test('refuses a non-URL', async () => {
    const added = await watchlist.addWatch({ url: 'laptop' })
    assert.equal(added.ok, false)
    assert.match(added.error ?? '', /product URL/i)
  })
})

describe('recordPrice', () => {
  test('appends a point and reports the change without a model doing arithmetic', async () => {
    await watchlist.addWatch({ url: 'https://shop.example/p/1', targetPrice: 250 })
    await watchlist.recordPrice('https://shop.example/p/1', 300, 'USD', 1000)
    const drop = await watchlist.recordPrice('https://shop.example/p/1', 275, 'USD', 2000)
    assert.equal(drop.previous, 300)
    assert.equal(drop.changed, -25)
    assert.equal(drop.hitTarget, false)

    const hit = await watchlist.recordPrice('https://shop.example/p/1', 240, 'USD', 3000)
    assert.equal(hit.hitTarget, true)
    assert.equal(hit.entry?.history.length, 3)
  })

  test('refuses a non-price rather than recording a zero', async () => {
    await watchlist.addWatch({ url: 'https://shop.example/p/1' })
    const out = await watchlist.recordPrice('https://shop.example/p/1', Number.NaN)
    assert.equal(out.ok, false)
    assert.equal((await watchlist.readWatchlist())[0].history.length, 0)
  })

  test('an unknown URL is an error, not a silent new entry', async () => {
    const out = await watchlist.recordPrice('https://shop.example/nope', 10)
    assert.equal(out.ok, false)
    assert.equal((await watchlist.readWatchlist()).length, 0)
  })

  test('matches by normalized URL, so a tagged link still finds its entry', async () => {
    await watchlist.addWatch({ url: 'https://shop.example/p/1' })
    const out = await watchlist.recordPrice('https://shop.example/p/1?tag=aff-20', 99)
    assert.equal(out.ok, true)
  })
})

describe('removeWatch', () => {
  test('removes by normalized URL', async () => {
    await watchlist.addWatch({ url: 'https://shop.example/p/1' })
    const out = await watchlist.removeWatch('https://shop.example/p/1?utm_source=x')
    assert.equal(out.removed, true)
    assert.equal((await watchlist.readWatchlist()).length, 0)
  })

  test('removing something absent reports so rather than throwing', async () => {
    const out = await watchlist.removeWatch('https://shop.example/nope')
    assert.equal(out.removed, false)
  })
})

describe('formatWatchlist', () => {
  test('an empty list says nothing was ever sent', () => {
    assert.match(watchlist.formatWatchlist([]), /never sent|Nothing is being tracked/)
  })

  test('shows the trend since the item was added', () => {
    const text = watchlist.formatWatchlist([
      {
        url: 'https://shop.example/p/1',
        name: 'Laptop',
        addedAt: 1,
        currency: 'USD',
        history: [
          { at: 1, price: 300 },
          { at: 2, price: 275 }
        ]
      }
    ])
    assert.match(text, /275/)
    assert.match(text, /↓ 25 since added/)
    assert.match(text, /never left the machine/)
  })

  test('an item with no price yet says so instead of showing zero', () => {
    const text = watchlist.formatWatchlist([
      { url: 'https://shop.example/p/1', name: 'Laptop', addedAt: 1, history: [] }
    ])
    assert.match(text, /no price recorded yet/)
  })
})
