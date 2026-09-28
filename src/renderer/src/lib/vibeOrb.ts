/**
 * VIBE's thinking orb (v3.1): the pure half — the mesh, its motion and its
 * projection. No DOM, so the node:test suite reaches it (test/vibeOrb.test.ts);
 * components/vibe/VibeOrb.tsx only draws what `orbFrame` returns.
 *
 * A geodesic sphere — an icosahedron subdivided once, 42 points and 120 edges —
 * turning slowly on two axes, its surface rippling on a travelling wave,
 * breathing on the lagoon's 4.8 s period (LagoonCanvas.tsx) so the orb and the
 * water it floats in keep one rhythm. Around it a tilted ring carries a spark.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface OrbMesh {
  vertices: Vec3[]
  edges: [number, number][]
}

/** The lagoon's breath, in seconds — the orb swells on the same beat. */
export const ORB_BREATH_S = 4.8
/** How far the ripple lifts or sinks a point, as a fraction of the radius. */
export const ORB_RIPPLE = 0.085
/** Where a still frame (reduced motion) is drawn from: a pose with a clear front and back. */
export const ORB_STILL_T = 2.2
/** The ring's radius, relative to the sphere's. */
export const ORB_RING_SCALE = 1.42
/** Points on the ring's polyline. */
export const ORB_RING_STEPS = 64

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / l, y: v.y / l, z: v.z / l }
}

/** An icosahedron subdivided `levels` times, every point on the unit sphere. */
export function icosphere(levels: number): OrbMesh {
  const p = (1 + Math.sqrt(5)) / 2
  const vertices: Vec3[] = (
    [
      [-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0],
      [0, -1, p], [0, 1, p], [0, -1, -p], [0, 1, -p],
      [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1]
    ] as const
  ).map(([x, y, z]) => normalize({ x, y, z }))
  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ]
  for (let level = 0; level < levels; level++) {
    const midpoints = new Map<string, number>()
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const known = midpoints.get(key)
      if (known !== undefined) return known
      const va = vertices[a]
      const vb = vertices[b]
      vertices.push(normalize({ x: va.x + vb.x, y: va.y + vb.y, z: va.z + vb.z }))
      midpoints.set(key, vertices.length - 1)
      return vertices.length - 1
    }
    faces = faces.flatMap(([a, b, c]) => {
      const ab = mid(a, b)
      const bc = mid(b, c)
      const ca = mid(c, a)
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca]
      ] as [number, number, number][]
    })
  }
  const seen = new Set<string>()
  const edges: [number, number][] = []
  for (const [a, b, c] of faces) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a]
    ]) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push(u < v ? [u, v] : [v, u])
    }
  }
  return { vertices, edges }
}

/** The one mesh every orb draws: built once, never mutated. */
export const ORB_MESH: OrbMesh = icosphere(1)

/** A point as drawn: screen offset from the centre, in radii, and its depth (−1 back … 1 front). */
export interface OrbPoint {
  x: number
  y: number
  depth: number
  /** 0 = the lagoon's cyan, 1 = its violet. */
  hue: number
}

export interface OrbFrame {
  /** Overall scale this frame — the breath. */
  scale: number
  /** 0…1, the breath's phase as brightness: dim on the exhale, full on the inhale. */
  glow: number
  points: OrbPoint[]
  ring: OrbPoint[]
  /** Index into `ring` of the spark riding it. */
  spark: number
}

/** Yaw about the vertical axis, then pitch toward the viewer, then roll in the picture plane. */
function rotate(v: Vec3, yaw: number, pitch: number, roll = 0): Vec3 {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const x1 = v.x * cy + v.z * sy
  const z1 = -v.x * sy + v.z * cy
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const y2 = v.y * cp - z1 * sp
  const z2 = v.y * sp + z1 * cp
  const cr = Math.cos(roll)
  const sr = Math.sin(roll)
  return { x: x1 * cr - y2 * sr, y: x1 * sr + y2 * cr, z: z2 }
}

/** Perspective, gentle: a camera four radii away. */
function project(v: Vec3, scale: number, hue: number): OrbPoint {
  const f = 4 / (4 - v.z)
  return { x: v.x * f * scale, y: -v.y * f * scale, depth: Math.max(-1, Math.min(1, v.z)), hue }
}

/**
 * Everything one frame of the orb needs, at `t` seconds. Deterministic in `t`,
 * so a still frame is a frame like any other, and the test can hold it.
 */
export function orbFrame(t: number, mesh: OrbMesh = ORB_MESH): OrbFrame {
  const breath = Math.sin((t * 2 * Math.PI) / ORB_BREATH_S)
  const scale = 0.93 + 0.06 * breath
  const glow = 0.7 + 0.3 * breath
  const yaw = t * 0.55
  const pitch = 0.45 + 0.22 * Math.sin(t * 0.31)
  // The colour drifts across the shell rather than the whole orb blinking.
  const drift = 0.5 + 0.5 * Math.sin(t * 0.37)

  const points = mesh.vertices.map((v) => {
    // A wave travelling over the surface: each point lifts on its own phase,
    // taken from where it sits, so the shell shimmers instead of pulsing.
    const lift = 1 + ORB_RIPPLE * Math.sin(t * 2.1 + 3.1 * v.x + 2.3 * v.y + 1.7 * v.z)
    const r = rotate({ x: v.x * lift, y: v.y * lift, z: v.z * lift }, yaw, pitch)
    const hue = Math.max(0, Math.min(1, 0.5 + 0.45 * r.y + 0.35 * (drift - 0.5)))
    return project(r, scale, hue)
  })

  // The ring: an orbit seen from a little above — tipped about 25° toward
  // the viewer so it reads as an ellipse that passes behind the sphere and in
  // front of it, and rolled off the horizontal so it does not sit like a
  // saturnine hat. It rocks slowly; the spark rides it once every 2.2 s.
  const ring: OrbPoint[] = []
  const tilt = 0.44 + 0.08 * Math.sin(t * 0.27)
  const roll = -0.42 + 0.1 * Math.sin(t * 0.21)
  for (let i = 0; i < ORB_RING_STEPS; i++) {
    const a = (i / ORB_RING_STEPS) * 2 * Math.PI
    const flat = { x: Math.cos(a) * ORB_RING_SCALE, y: 0, z: Math.sin(a) * ORB_RING_SCALE }
    const r = rotate(flat, 0, tilt, roll)
    // Hue runs once round the ring, cyan through violet and back.
    ring.push(project(r, scale, 0.5 - 0.5 * Math.cos(a)))
  }
  const spark = Math.floor(((((t / 2.2) % 1) + 1) % 1) * ORB_RING_STEPS) % ORB_RING_STEPS

  return { scale, glow, points, ring, spark }
}
