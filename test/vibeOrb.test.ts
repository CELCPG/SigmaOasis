import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  icosphere,
  ORB_MESH,
  ORB_RING_STEPS,
  ORB_RIPPLE,
  ORB_STILL_T,
  orbFrame
} from '../src/renderer/src/lib/vibeOrb'
import type { ModelConfig } from '../src/renderer/src/types'

/**
 * v3.1: VIBE's thinking orb — its mesh and motion (lib/vibeOrb.ts), the
 * markup that stands in for it where there is no canvas, and the warm-up that
 * starts the model's load before Enter (hooks/warmModel.ts).
 */

describe('the orb mesh', () => {
  test('an icosahedron, and once subdivided a 42-point geodesic with 120 edges', () => {
    const ico = icosphere(0)
    assert.equal(ico.vertices.length, 12)
    assert.equal(ico.edges.length, 30)
    assert.equal(ORB_MESH.vertices.length, 42)
    assert.equal(ORB_MESH.edges.length, 120)
  })

  test('every point sits on the unit sphere and every edge is drawn once', () => {
    for (const v of ORB_MESH.vertices) assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-9)
    const keys = new Set(ORB_MESH.edges.map(([a, b]) => `${a}:${b}`))
    assert.equal(keys.size, ORB_MESH.edges.length)
    for (const [a, b] of ORB_MESH.edges) assert.ok(a < b && b < ORB_MESH.vertices.length)
  })
})

describe('the orb in motion', () => {
  test('a frame is a function of time alone, so a still frame is repeatable', () => {
    assert.deepEqual(orbFrame(ORB_STILL_T), orbFrame(ORB_STILL_T))
    assert.notDeepEqual(orbFrame(0).points[0], orbFrame(1).points[0])
  })

  test('the ripple and the breath stay inside the canvas the component draws on', () => {
    // VibeOrb.tsx draws the sphere at 0.19 of a 144px box, whose edge is 2.6
    // radii out, so anything within 2.5 radii of the centre is on the canvas.
    for (let t = 0; t < 30; t += 0.37) {
      const f = orbFrame(t)
      assert.equal(f.points.length, ORB_MESH.vertices.length)
      assert.equal(f.ring.length, ORB_RING_STEPS)
      assert.ok(f.spark >= 0 && f.spark < ORB_RING_STEPS)
      for (const p of [...f.points, ...f.ring]) {
        assert.ok(Math.hypot(p.x, p.y) < 2.5, `a point at ${Math.hypot(p.x, p.y).toFixed(2)} radii leaves the canvas`)
        assert.ok(p.depth >= -1 && p.depth <= 1)
        assert.ok(p.hue >= 0 && p.hue <= 1)
      }
      // The shell never swells past its ripple and breath.
      const shell = Math.max(...f.points.map((p) => Math.hypot(p.x, p.y)))
      assert.ok(shell <= (1 + ORB_RIPPLE) * f.scale * (4 / 3) + 1e-9)
    }
  })

  test('it breathes on the lagoon’s period', () => {
    const scales = Array.from({ length: 49 }, (_, i) => orbFrame(i * 0.1).scale)
    const peak = scales.indexOf(Math.max(...scales))
    const trough = scales.indexOf(Math.min(...scales))
    // A quarter period (1.2 s) to the peak, three quarters (3.6 s) to the trough.
    assert.ok(Math.abs(peak * 0.1 - 1.2) < 0.11)
    assert.ok(Math.abs(trough * 0.1 - 3.6) < 0.11)
  })
})

describe('the orb in the scene', () => {
  test('without a canvas it is still a named status, and nothing else', async () => {
    const { VibeOrb } = await import('../src/renderer/src/components/vibe/VibeOrb')
    const html = renderToStaticMarkup(createElement(VibeOrb, { still: false }))
    assert.match(html, /^<div class="vibe-thinking" role="status" aria-label="Thinking"><canvas [^>]*aria-hidden="true"/)
  })
})

describe('warming the composer’s model (v3.1)', () => {
  const slot = (id: string, modelId: string, extra: Partial<ModelConfig> = {}): ModelConfig =>
    ({ id, modelId, enabled: true, roleName: id, ...extra }) as ModelConfig

  const setup = async (models: ModelConfig[], conversations: unknown[] = []) => {
    const pinned: string[] = []
    ;(globalThis as { window?: unknown }).window = {
      api: { pinModel: async (id: string) => (pinned.push(id), true), saveConversation: async () => true }
    }
    const { useAppStore } = await import('../src/renderer/src/stores/appStore')
    useAppStore.setState({ settings: { models } as never, conversations } as never)
    const warm = await import('../src/renderer/src/hooks/warmModel')
    return { pinned, ...warm }
  }

  test('the conversation’s own slot, if enabled; else the first enabled one', async () => {
    const { composerModelId } = await setup(
      [slot('a', 'model-a', { enabled: false }), slot('b', 'model-b'), slot('c', 'model-c')],
      [
        { id: 'k1', activeModelSlotId: 'c', messages: [] },
        { id: 'k2', activeModelSlotId: 'a', messages: [] }
      ]
    )
    assert.equal(composerModelId('k1'), 'model-c')
    assert.equal(composerModelId('k2'), 'model-b', 'a disabled slot is not the one that answers')
    assert.equal(composerModelId(null), 'model-b')
  })

  test('an agent chat warms its task’s slot', async () => {
    const { composerModelId } = await setup(
      [slot('chat', 'chat-model'), slot('code', 'code-model', { specialty: 'coding' } as Partial<ModelConfig>)],
      [{ id: 'k', activeModelSlotId: 'chat', agent: { folder: '/x' }, messages: [] }]
    )
    assert.equal(composerModelId('k'), 'code-model')
  })

  test('once per model per interval, and nothing at all with no model', async () => {
    const { pinned, warmComposerModel } = await setup([slot('b', 'model-warm')])
    warmComposerModel(null, 1_000_000)
    warmComposerModel(null, 1_005_000)
    assert.deepEqual(pinned, ['model-warm'])
    warmComposerModel(null, 1_020_000)
    assert.deepEqual(pinned, ['model-warm', 'model-warm'])

    const empty = await setup([slot('e', '  ')])
    empty.warmComposerModel(null, 2_000_000)
    assert.deepEqual(empty.pinned, [])
  })
})
