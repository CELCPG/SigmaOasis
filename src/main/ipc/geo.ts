import { auditedFetch } from './net'
import { GENERIC_USER_AGENT } from './userAgent'

/**
 * Places, distances and stop ordering — the arithmetic behind "how far is it".
 *
 * Three of the measured sessions asked questions the toolbox could not answer
 * at all, so the model answered them from memory and the app flagged the
 * result:
 *
 *   - "highest rated restaurants within a 10 min walk of Penn Station" —
 *     answered with a list and no distance behind any of it
 *   - "list the closest michelin star restaurants", which produced a table of
 *     Uber times ("~7 mins", "~9 mins") that were pure invention, next to
 *     addresses that were also invented
 *   - "plan a route in NYC … 8 stops", ordered by vibe
 *
 * No amount of detection fixes those; the question needs coordinates. This
 * module gets them from OpenStreetMap's Nominatim, which is open, keyless, and
 * run by a nonprofit — and it is a new outbound destination, so it goes
 * through `auditedFetch` under its own purpose with a single-host allowlist,
 * appears in the network activity log like everything else, and follows the
 * proxy.
 *
 * On honesty about distance: everything here is straight-line. A real street
 * route is longer, and a drive time depends on traffic this tool cannot see.
 * So it reports the crow-flies distance, applies a stated detour factor for a
 * walking estimate, and refuses to estimate driving at all — the invented
 * "~7 mins" is exactly what it exists to replace, and replacing it with a
 * different invented number would be no better.
 */

export interface GeoArgs {
  operation?: unknown
  place?: unknown
  from?: unknown
  to?: unknown
  stops?: unknown
}

export interface GeoResult {
  ok: boolean
  output?: string
  error?: string
}

export interface Place {
  /** What the user asked for. */
  query: string
  /** Nominatim's canonical name for the match. */
  name: string
  latitude: number
  longitude: number
  /** OSM's classification, e.g. "railway station", "restaurant". */
  kind: string
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
/** Nominatim asks for at most one request a second. Honored, not assumed. */
const MIN_REQUEST_GAP_MS = 1100
/** A route this tool will order. Beyond it the request is the wrong shape. */
const MAX_STOPS = 12

/**
 * Straight-line kilometres between two points.
 *
 * The earth is not flat and the difference matters over a city: a planar
 * approximation is out by enough to reorder two nearby stops, which is the one
 * thing an ordering tool must not do.
 */
export function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const R = 6371
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Streets are not straight lines. In a dense grid the walked distance runs
 * about a third longer than the crow-flies one, and this factor is stated in
 * the output rather than folded in silently — a reader who knows the estimate
 * is an estimate can judge it.
 */
const STREET_DETOUR = 1.3
/** Comfortable adult walking pace, km/h. */
const WALK_KMH = 4.8

export function walkMinutes(straightLineKm: number): number {
  return Math.round((straightLineKm * STREET_DETOUR) / WALK_KMH * 60)
}

export function formatDistance(km: number): string {
  const miles = km * 0.621371
  return km < 1
    ? `${Math.round(km * 1000)} m (${(miles * 5280).toFixed(0)} ft)`
    : `${km.toFixed(2)} km (${miles.toFixed(2)} mi)`
}

// ---- lookup ------------------------------------------------------------------

/**
 * Resolved places, by query. Place names repeat constantly inside one task —
 * a route asks for the same start point on every leg — and a cache turns an
 * eight-stop ordering from eight requests into as few as one.
 */
const cache = new Map<string, Place | null>()
let lastRequestAt = 0

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function clearGeoCache(): void {
  cache.clear()
}

/** Look up one place. Returns null when nothing matched — never a guess. */
export async function geocode(query: string): Promise<Place | null> {
  const key = query.trim().toLowerCase()
  if (!key) return null
  if (cache.has(key)) return cache.get(key) ?? null

  const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt)
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()

  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&addressdetails=0`
  const res = await auditedFetch(
    url,
    { headers: { 'User-Agent': GENERIC_USER_AGENT, Accept: 'application/json' }, timeoutMs: 15_000 },
    'geo'
  )
  if (!res.ok) throw new Error(`Place lookup returned HTTP ${res.status}`)
  const data = (await res.json()) as {
    display_name?: string
    lat?: string
    lon?: string
    type?: string
    category?: string
  }[]

  const first = data?.[0]
  const latitude = Number(first?.lat)
  const longitude = Number(first?.lon)
  if (!first || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    cache.set(key, null)
    return null
  }
  const place: Place = {
    query,
    name: first.display_name ?? query,
    latitude,
    longitude,
    kind: [first.category, first.type].filter(Boolean).join(' / ') || 'place'
  }
  cache.set(key, place)
  return place
}

function describePlace(p: Place): string {
  return `${p.name}\n  ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)} — ${p.kind}`
}

/** The disclaimer every distance carries. Stated once per output, never dropped. */
const STRAIGHT_LINE_NOTE =
  'Distances are straight-line. Walking estimates apply a ' +
  `${STREET_DETOUR}× street-detour factor at ${WALK_KMH} km/h and are approximate. Driving and ` +
  'ride-hail times depend on traffic and are NOT estimated here — do not state one.'

// ---- operations ----------------------------------------------------------------

async function find(place: string): Promise<GeoResult> {
  const found = await geocode(place)
  if (!found) {
    return {
      ok: false,
      error:
        `No place matched ${JSON.stringify(place)}. Try a fuller name with its city, or tell ` +
        'the user it could not be located — do not supply coordinates or an address from memory.'
    }
  }
  return { ok: true, output: describePlace(found) }
}

async function distance(from: string, to: string): Promise<GeoResult> {
  const [a, b] = [await geocode(from), await geocode(to)]
  const missing = [!a && from, !b && to].filter(Boolean)
  if (missing.length > 0) {
    return { ok: false, error: `Could not locate: ${missing.join(', ')}. Do not estimate instead.` }
  }
  const km = haversineKm(a!, b!)
  return {
    ok: true,
    output: [
      `From: ${a!.name}`,
      `To:   ${b!.name}`,
      `Straight-line distance: ${formatDistance(km)}`,
      `Walking: about ${walkMinutes(km)} minute(s)`,
      '',
      STRAIGHT_LINE_NOTE
    ].join('\n')
  }
}

/**
 * Order stops by nearest-neighbour from a starting point.
 *
 * Nearest-neighbour, not optimal — and the output says so. An optimal tour is
 * a different and much harder problem, and quietly presenting a greedy answer
 * as "the best route" would be the same class of overclaim as an invented
 * drive time.
 */
async function order(from: string, stops: string[]): Promise<GeoResult> {
  if (stops.length === 0) return { ok: false, error: 'No stops given to order.' }
  if (stops.length > MAX_STOPS) {
    return { ok: false, error: `Too many stops (${stops.length}); ${MAX_STOPS} is the maximum.` }
  }
  const start = await geocode(from)
  if (!start) return { ok: false, error: `Could not locate the starting point ${JSON.stringify(from)}.` }

  const located: Place[] = []
  const unlocated: string[] = []
  for (const stop of stops) {
    const p = await geocode(stop)
    if (p) located.push(p)
    else unlocated.push(stop)
  }
  if (located.length === 0) {
    return { ok: false, error: `None of the stops could be located: ${stops.join(', ')}.` }
  }

  const remaining = [...located]
  const route: { place: Place; legKm: number }[] = []
  let current: Place = start
  while (remaining.length > 0) {
    let bestIndex = 0
    let bestKm = Infinity
    remaining.forEach((p, i) => {
      const km = haversineKm(current, p)
      if (km < bestKm) {
        bestKm = km
        bestIndex = i
      }
    })
    const [next] = remaining.splice(bestIndex, 1)
    route.push({ place: next, legKm: bestKm })
    current = next
  }

  const total = route.reduce((sum, leg) => sum + leg.legKm, 0)
  const lines = [
    `Start: ${start.name}`,
    ...route.map(
      (leg, i) =>
        `${i + 1}. ${leg.place.name}\n   ${formatDistance(leg.legKm)} from the previous stop` +
        ` — about ${walkMinutes(leg.legKm)} min on foot`
    ),
    '',
    `Total, straight-line: ${formatDistance(total)} over ${route.length} stop(s).`,
    'Ordered nearest-neighbour from the start. That is a reasonable order, not a proven optimal one.'
  ]
  if (unlocated.length > 0) {
    lines.push(
      `Not located, and therefore not in this route: ${unlocated.join(', ')}. Say so rather than ` +
        'placing them from memory.'
    )
  }
  lines.push('', STRAIGHT_LINE_NOTE)
  return { ok: true, output: lines.join('\n') }
}

/** Entry point used by the tool dispatcher. */
export async function runGeoQuery(args: GeoArgs): Promise<GeoResult> {
  const operation = String(args.operation ?? 'find')
  try {
    if (operation === 'find') {
      const place = String(args.place ?? '').trim()
      if (!place) return { ok: false, error: '"place" is required.' }
      return await find(place)
    }
    if (operation === 'distance') {
      const from = String(args.from ?? '').trim()
      const to = String(args.to ?? '').trim()
      if (!from || !to) return { ok: false, error: 'Both "from" and "to" are required.' }
      return await distance(from, to)
    }
    if (operation === 'order') {
      const from = String(args.from ?? '').trim()
      const stops = Array.isArray(args.stops)
        ? args.stops.map((s) => String(s ?? '').trim()).filter(Boolean)
        : []
      if (!from) return { ok: false, error: '"from" (the starting point) is required.' }
      return await order(from, stops)
    }
    return {
      ok: false,
      error: `Unknown operation ${JSON.stringify(operation)}. Use "find", "distance" or "order".`
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
