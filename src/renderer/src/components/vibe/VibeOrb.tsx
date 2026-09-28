import { useEffect, useRef } from 'react'
import { ORB_MESH, ORB_STILL_T, orbFrame, type OrbFrame, type OrbPoint } from '../../lib/vibeOrb'

/**
 * VIBE's thinking orb (v3.1): what the lagoon shows while a turn is running
 * and no words have surfaced — the model thinking, or a tool working. It says
 * that something is happening, never what: naming the tool is the noise VIBE
 * takes away (lib/vibe.ts, `VibePhase`).
 *
 * The motion is lib/vibeOrb.ts; this only draws it. A 2D canvas rather than a
 * second WebGL context beside the lagoon's: 120 short lines a frame on a
 * 144-pixel canvas costs nothing a GPU notices, and a 2D context cannot be
 * lost. Additive blending makes crossing lines brighter where they meet, the
 * way light does in water, and removes any need to sort by depth.
 *
 * Under reduced motion it is one still frame, and its halo holds still (CSS).
 */

const SIZE = 144
/** The sphere's radius in CSS pixels; the ring reaches about 1.7 of these. */
const RADIUS = SIZE * 0.19
const CYAN = [79, 255, 209] as const
const VIOLET = [167, 139, 250] as const

function tint(hue: number, alpha: number): string {
  const r = Math.round(CYAN[0] + (VIOLET[0] - CYAN[0]) * hue)
  const g = Math.round(CYAN[1] + (VIOLET[1] - CYAN[1]) * hue)
  const b = Math.round(CYAN[2] + (VIOLET[2] - CYAN[2]) * hue)
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`
}

/** Front (depth 1) is bright, back (−1) is a faint trace. */
function presence(depth: number): number {
  const front = (depth + 1) / 2
  return 0.08 + 0.8 * front * front
}

function drawFrame(ctx: CanvasRenderingContext2D, frame: OrbFrame, dpr: number): void {
  const c = SIZE / 2
  const at = (p: OrbPoint): [number, number] => [c + p.x * RADIUS, c + p.y * RADIUS]
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, SIZE, SIZE)
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'

  const ringSegment = (front: boolean): void => {
    const { ring } = frame
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const depth = (a.depth + b.depth) / 2
      if (depth >= 0 !== front) continue
      const alpha = (front ? 0.62 : 0.3) * (0.45 + 0.55 * presence(depth)) * frame.glow
      ctx.strokeStyle = tint(a.hue, alpha * 0.3)
      ctx.lineWidth = 3.2
      ctx.beginPath()
      ctx.moveTo(...at(a))
      ctx.lineTo(...at(b))
      ctx.stroke()
      ctx.strokeStyle = tint(a.hue, alpha)
      ctx.lineWidth = 1.1
      ctx.beginPath()
      ctx.moveTo(...at(a))
      ctx.lineTo(...at(b))
      ctx.stroke()
    }
  }

  // The ring's far side passes behind the sphere.
  ringSegment(false)

  // The core: a small sun inside the shell, breathing with it.
  const core = ctx.createRadialGradient(c, c, 0, c, c, RADIUS * 1.05 * frame.scale)
  core.addColorStop(0, `rgba(216,255,246,${(0.5 * frame.glow).toFixed(3)})`)
  core.addColorStop(0.4, `rgba(79,255,209,${(0.2 * frame.glow).toFixed(3)})`)
  core.addColorStop(1, 'rgba(167,139,250,0)')
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(c, c, RADIUS * 1.05 * frame.scale, 0, Math.PI * 2)
  ctx.fill()

  // The shell: a wide faint pass for the glow, then the line itself.
  for (const [i, j] of ORB_MESH.edges) {
    const a = frame.points[i]
    const b = frame.points[j]
    const depth = (a.depth + b.depth) / 2
    const alpha = presence(depth) * frame.glow
    const hue = (a.hue + b.hue) / 2
    const [ax, ay] = at(a)
    const [bx, by] = at(b)
    ctx.strokeStyle = tint(hue, alpha * 0.22)
    ctx.lineWidth = 3.4
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
    ctx.strokeStyle = tint(hue, alpha)
    ctx.lineWidth = 1.05
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
  }

  // Points of light where the lines meet, on the near side only.
  for (const p of frame.points) {
    if (p.depth < 0.1) continue
    const [x, y] = at(p)
    ctx.fillStyle = `rgba(216,255,246,${(0.85 * presence(p.depth) * frame.glow).toFixed(3)})`
    ctx.beginPath()
    ctx.arc(x, y, 1.4, 0, Math.PI * 2)
    ctx.fill()
  }

  ringSegment(true)

  // The spark: a comet with a tail along the ring, dimmer while it passes
  // behind the sphere.
  const { ring, spark } = frame
  const TAIL = 11
  for (let k = TAIL; k >= 0; k--) {
    const p = ring[(spark - k + ring.length) % ring.length]
    const [x, y] = at(p)
    const fade = 1 - k / (TAIL + 1)
    const lit = (p.depth >= 0 ? 1 : 0.45) * fade * fade
    ctx.fillStyle = tint(p.hue, 0.9 * lit)
    ctx.beginPath()
    ctx.arc(x, y, 0.7 + 1.9 * fade, 0, Math.PI * 2)
    ctx.fill()
  }
  const head = ring[spark]
  const [hx, hy] = at(head)
  const flare = ctx.createRadialGradient(hx, hy, 0, hx, hy, 7)
  flare.addColorStop(0, `rgba(236,255,250,${head.depth >= 0 ? 0.95 : 0.4})`)
  flare.addColorStop(1, 'rgba(79,255,209,0)')
  ctx.fillStyle = flare
  ctx.beginPath()
  ctx.arc(hx, hy, 7, 0, Math.PI * 2)
  ctx.fill()
}

export function VibeOrb({ still }: { still: boolean }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = SIZE * dpr
    canvas.height = SIZE * dpr
    if (still) {
      drawFrame(ctx, orbFrame(ORB_STILL_T), dpr)
      return
    }
    const started = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      drawFrame(ctx, orbFrame((now - started) / 1000), dpr)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [still])

  return (
    <div className="vibe-thinking" role="status" aria-label="Thinking">
      <canvas ref={canvasRef} width={SIZE} height={SIZE} aria-hidden="true" />
    </div>
  )
}
