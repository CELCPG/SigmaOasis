import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { load, state, resetState } from './harness'

const geo = load<typeof import('../src/main/ipc/geo')>('geo')
const net = load<typeof import('../src/main/ipc/net')>('net')

/**
 * The questions this tool exists for, all of which the app previously answered
 * from memory: "within a 10 minute walk of Penn Station", "list the closest
 * michelin star restaurants" — which produced a table of invented Uber times
 * beside invented addresses — and an eight-stop route ordered by vibe.
 *
 * The arithmetic is tested directly. What the network does is tested through
 * the harness, because the one thing that must never regress is that a place
 * lookup is an audited, allowlisted, single-host request like everything else.
 */

// Two real reference points, ~1.1 km apart along Manhattan's grid.
const PENN = { latitude: 40.7506, longitude: -73.9936 }
const BRYANT = { latitude: 40.7536, longitude: -73.9832 }

beforeEach(() => {
  resetState()
  geo.clearGeoCache()
})

describe('haversineKm', () => {
  test('measures a short city hop', () => {
    const km = geo.haversineKm(PENN, BRYANT)
    assert.ok(km > 0.85 && km < 1.05, `expected ~0.9 km, got ${km}`)
  })

  test('a point is zero from itself', () => {
    assert.equal(geo.haversineKm(PENN, PENN), 0)
  })

  test('it is symmetric', () => {
    assert.equal(
      geo.haversineKm(PENN, BRYANT).toFixed(9),
      geo.haversineKm(BRYANT, PENN).toFixed(9)
    )
  })

  test('it is spherical, not planar — a degree of longitude shrinks with latitude', () => {
    // The flat approximation gets these equal, which is enough to reorder two
    // nearby stops, and reordering stops is the one thing this must not do.
    const atEquator = geo.haversineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })
    const atSixty = geo.haversineKm({ latitude: 60, longitude: 0 }, { latitude: 60, longitude: 1 })
    assert.ok(atSixty < atEquator * 0.55, `${atSixty} should be about half of ${atEquator}`)
  })
})

describe('walkMinutes', () => {
  test('a kilometre is a quarter of an hour, near enough', () => {
    // 1 km straight-line, 1.3x detour, 4.8 km/h.
    assert.equal(geo.walkMinutes(1), 16)
  })

  test('the 10-minute-walk question gets a usable answer', () => {
    // The original ask. About 600 m straight-line is the honest boundary.
    assert.ok(geo.walkMinutes(0.6) <= 10)
    assert.ok(geo.walkMinutes(1.2) > 10)
  })
})

describe('formatDistance', () => {
  test('short distances read in metres and feet', () => {
    assert.match(geo.formatDistance(0.25), /^250 m \(\d+ ft\)$/)
  })

  test('longer ones in km and miles', () => {
    assert.match(geo.formatDistance(4), /^4\.00 km \(2\.49 mi\)$/)
  })
})

describe('geocode · the request itself', () => {
  test('goes through the audited path under its own purpose', async () => {
    state.responses = [
      {
        match: 'nominatim',
        contentType: 'application/json',
        body: JSON.stringify([
          { display_name: 'Pennsylvania Station, New York', lat: '40.7506', lon: '-73.9936', category: 'railway', type: 'station' }
        ])
      }
    ]
    const place = await geo.geocode('Penn Station, New York')
    assert.equal(place?.latitude, 40.7506)
    const call = state.fetchLog.find((f) => f.url.includes('nominatim'))
    assert.ok(call, 'expected the lookup to be audited')
    assert.equal(call!.purpose, 'geo')
  })

  test('only OpenStreetMap is reachable under that purpose', () => {
    // A wildcard here would turn a place lookup into a general egress hole.
    assert.deepEqual(net.allowedHosts('geo'), ['nominatim.openstreetmap.org'])
  })

  test('no match returns null rather than a guess', async () => {
    state.responses = [{ match: 'nominatim', contentType: 'application/json', body: '[]' }]
    assert.equal(await geo.geocode('a place that does not exist at all'), null)
  })

  test('a repeated place is served from cache, not re-fetched', async () => {
    state.responses = [
      {
        match: 'nominatim',
        contentType: 'application/json',
        body: JSON.stringify([{ display_name: 'Penn Station', lat: '40.75', lon: '-73.99' }])
      }
    ]
    await geo.geocode('Penn Station')
    await geo.geocode('penn station')
    const calls = state.fetchLog.filter((f) => f.url.includes('nominatim'))
    assert.equal(calls.length, 1, 'the second lookup should not leave the machine')
  })
})

describe('runGeoQuery', () => {
  const withPlaces = (places: Record<string, [number, number]>): void => {
    state.responses = Object.entries(places).map(([name, [lat, lon]]) => ({
      match: encodeURIComponent(name).slice(0, 24),
      contentType: 'application/json',
      body: JSON.stringify([{ display_name: name, lat: String(lat), lon: String(lon) }])
    }))
  }

  test('distance reports straight-line and a walk, and refuses to estimate driving', async () => {
    withPlaces({ 'Penn Station': [40.7506, -73.9936], 'Bryant Park': [40.7536, -73.9832] })
    const out = await geo.runGeoQuery({ operation: 'distance', from: 'Penn Station', to: 'Bryant Park' })
    assert.ok(out.ok, out.error)
    assert.match(out.output!, /Straight-line distance/)
    assert.match(out.output!, /Walking: about \d+ minute/)
    // The invented "~7 mins" Uber column is the thing this replaces.
    assert.match(out.output!, /NOT estimated here — do not state one/)
  })

  test('a place that cannot be found is reported, never filled in', async () => {
    state.responses = [{ match: 'nominatim', contentType: 'application/json', body: '[]' }]
    const out = await geo.runGeoQuery({ operation: 'find', place: 'nowhere at all' })
    assert.equal(out.ok, false)
    assert.match(out.error!, /do not supply coordinates or an address from memory/)
  })

  test('an unknown operation names the ones that exist', async () => {
    const out = await geo.runGeoQuery({ operation: 'navigate' })
    assert.equal(out.ok, false)
    assert.match(out.error!, /"find", "distance" or "order"/)
  })

  test('ordering is labelled nearest-neighbour, not optimal', async () => {
    withPlaces({
      'Penn Station': [40.7506, -73.9936],
      'Bryant Park': [40.7536, -73.9832],
      'Union Square': [40.7359, -73.9911]
    })
    const out = await geo.runGeoQuery({
      operation: 'order',
      from: 'Penn Station',
      stops: ['Union Square', 'Bryant Park']
    })
    assert.ok(out.ok, out.error)
    assert.match(out.output!, /not a proven optimal one/)
    assert.match(out.output!, /Total, straight-line/)
  })

  test('stops that could not be located are named, not quietly dropped', async () => {
    state.responses = [
      {
        match: 'Penn',
        contentType: 'application/json',
        body: JSON.stringify([{ display_name: 'Penn Station', lat: '40.75', lon: '-73.99' }])
      },
      { match: 'nominatim', contentType: 'application/json', body: '[]' }
    ]
    const out = await geo.runGeoQuery({
      operation: 'order',
      from: 'Penn Station',
      stops: ['Penn Station', 'a shop that closed in 2019']
    })
    assert.ok(out.ok, out.error)
    assert.match(out.output!, /Not located.*a shop that closed in 2019/s)
    assert.match(out.output!, /rather than\s+placing them from memory/s)
  })

  test('an absurd number of stops is refused', async () => {
    const out = await geo.runGeoQuery({
      operation: 'order',
      from: 'Penn Station',
      stops: Array.from({ length: 40 }, (_, i) => `stop ${i}`)
    })
    assert.equal(out.ok, false)
    assert.match(out.error!, /Too many stops/)
  })
})
