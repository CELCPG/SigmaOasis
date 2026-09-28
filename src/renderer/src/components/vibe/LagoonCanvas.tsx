import { useEffect, useRef } from 'react'
import type { VibePhase } from '../../lib/vibe'

/**
 * The VIBE lagoon (v3.0): the light a rippled surface throws on a pool floor,
 * drawn by one fragment shader, over a deep blue that brightens toward the
 * surface. The CSS layers under it (index.css `.vibe-root`) are the whole
 * picture when WebGL is unavailable, so this component can fail silently: no
 * context, a lost context, a compile error — the canvas simply never fades in.
 *
 * Cost, deliberately bounded:
 * - rendered at half the CSS size and scaled up — water is soft, and a
 *   quarter of the pixels is a quarter of the work;
 * - capped at 30 frames a second, and rAF already stops for a hidden window;
 * - under reduced motion, one still frame, redrawn only when the phase
 *   changes the light's energy.
 *
 * The light's energy follows the phase: resting when nothing runs, a slow
 * breath while the model thinks, a steady glow while words surface. The
 * transition between them is eased per frame, so a phase change swells
 * rather than switches.
 */

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

// Two textbook pieces, composed: fractal value noise for the slow swell of the
// surface, and a cellular (Worley) field whose F2 − F1 is small along cell
// borders — the bright, curved network of light a rippled surface focuses
// onto a pool floor. The swell warps the cells, so the network flows rather
// than wobbles in place, and two layers at different scales overlap the way
// real caustics do.
const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform float u_energy;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 hash2(vec2 p) {
  return vec2(hash(p), hash(p + 17.31));
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

// F2 - F1 over a jittered lattice whose points drift in small orbits.
float cellEdges(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash2(i + g);
      o = 0.5 + 0.42 * sin(t * 0.35 + 6.2831 * o);
      float d = length(g + o - f);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return f2 - f1;
}

float caustic(vec2 p, float t) {
  vec2 swell = vec2(fbm(p * 0.55 + vec2(0.0, t * 0.03)), fbm(p * 0.55 + vec2(3.1, 7.7) - vec2(t * 0.025, 0.0)));
  float e = cellEdges(p + swell * 1.1, t);
  // A sharp line and a wide soft halo around it: the halo is the glow.
  float line = pow(1.0 - smoothstep(0.0, 0.2, e), 3.0);
  float halo = 1.0 - smoothstep(0.0, 0.55, e);
  return line + 0.2 * halo * halo;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float t = u_time;

  // Depth: lighter toward the top, where the surface is.
  vec3 deep = vec3(0.004, 0.014, 0.042);
  vec3 shallow = vec3(0.01, 0.07, 0.15);
  vec3 col = mix(deep, shallow, smoothstep(-0.2, 1.2, uv.y));

  float a = caustic(p * 3.2, t);
  float b = caustic(p * 5.1 + 11.0, t * 1.25);
  vec3 cyan = vec3(0.31, 1.0, 0.82);
  vec3 violet = vec3(0.62, 0.52, 1.0);
  float hue = 0.5 + 0.5 * sin(p.x * 1.1 - p.y * 0.8 + t * 0.06);
  vec3 light = mix(cyan, violet, hue);
  // The network is brightest near the surface and fades into the deep.
  float depthFade = mix(0.45, 1.0, smoothstep(-0.1, 1.0, uv.y));
  // Light pools unevenly: slow patches where the surface focuses more of it.
  float pool = mix(0.35, 1.15, smoothstep(0.3, 0.75, fbm(p * 1.3 + vec2(t * 0.018, -t * 0.012))));
  col += light * (a * 0.5 + b * 0.28) * depthFade * pool * (0.2 + 0.3 * u_energy);

  float glow = fbm(p * 0.8 + vec2(t * 0.02, t * 0.015));
  col += mix(cyan, violet, 1.0 - hue) * pow(glow, 3.0) * (0.1 + 0.16 * u_energy);

  float v = smoothstep(1.3, 0.3, length(p * vec2(0.9, 1.1)));
  col *= mix(0.5, 1.0, v);
  gl_FragColor = vec4(col, 1.0);
}
`

/** The energy each phase settles toward; breathing oscillates around its own. */
function targetEnergy(phase: VibePhase, seconds: number): number {
  if (phase === 'surfacing') return 0.85
  // One breath every ~4.8 s, the same period as the CSS aurora's.
  if (phase === 'breathing') return 0.4 + 0.3 * Math.sin((seconds * 2 * Math.PI) / 4.8)
  return 0
}

const FRAME_MS = 1000 / 30
const RESOLUTION = 0.5
/** Where a still frame is drawn from: a moment with a pleasant knot of light. */
const STILL_TIME = 17

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export function LagoonCanvas({ phase, still }: { phase: VibePhase; still: boolean }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  // Read by the render loop, which is set up once and must not restart (and
  // lose its eased energy) every time the phase changes.
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const redrawRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // A canvas per run, made here rather than rendered: the cleanup below
    // hands its context back, and a lost context cannot be taken again from
    // the same element — which StrictMode's mount-unmount-mount, and a switch
    // of the reduced-motion preference, would both otherwise try to do.
    const canvas = document.createElement('canvas')
    canvas.className = 'vibe-canvas'
    canvas.dataset.ready = 'false'
    host.appendChild(canvas)
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    if (!gl) return () => canvas.remove()

    const release = (): void => {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
    const program = vs && fs ? gl.createProgram() : null
    if (!vs || !fs || !program) return release
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return release
    gl.useProgram(program)

    // One triangle pair covering clip space.
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
    const uRes = gl.getUniformLocation(program, 'u_res')
    const uTime = gl.getUniformLocation(program, 'u_time')
    const uEnergy = gl.getUniformLocation(program, 'u_energy')

    let lost = false
    const onLost = (e: Event): void => {
      e.preventDefault()
      lost = true
      canvas.dataset.ready = 'false'
    }
    canvas.addEventListener('webglcontextlost', onLost)

    const resize = (): void => {
      const w = Math.max(1, Math.round(canvas.clientWidth * RESOLUTION))
      const h = Math.max(1, Math.round(canvas.clientHeight * RESOLUTION))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
    }

    let energy = 0
    const draw = (seconds: number, eased: number): void => {
      if (lost) return
      resize()
      gl.uniform2f(uRes, canvas.width, canvas.height)
      // Wrapped so a window left open for days keeps its float precision.
      gl.uniform1f(uTime, seconds % 3600)
      gl.uniform1f(uEnergy, eased)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      canvas.dataset.ready = 'true'
    }

    const observer = new ResizeObserver(() => {
      if (still) redrawRef.current?.()
    })
    observer.observe(canvas)

    let raf = 0
    if (still) {
      // Reduced motion: one frame at the energy the phase asks for, redrawn
      // when the phase changes — a change of light, not a movement.
      redrawRef.current = () => draw(STILL_TIME, targetEnergy(phaseRef.current, STILL_TIME) * 0.6)
      redrawRef.current()
    } else {
      const started = performance.now()
      let last = 0
      const frame = (now: number): void => {
        raf = requestAnimationFrame(frame)
        if (now - last < FRAME_MS) return
        const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
        last = now
        const seconds = (now - started) / 1000
        // Ease toward the target: ~1.2 s to cover most of a change.
        energy += (targetEnergy(phaseRef.current, seconds) - energy) * Math.min(1, dt * 2.2)
        draw(seconds, energy)
      }
      raf = requestAnimationFrame(frame)
    }

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      redrawRef.current = null
      // Hand the GPU context back now rather than whenever GC gets to it —
      // leaving and re-entering VIBE must not accumulate contexts.
      release()
    }
  }, [still])

  // Reduced motion redraws on a phase change; the animated loop reads the ref.
  useEffect(() => {
    redrawRef.current?.()
  }, [phase])

  return <div ref={hostRef} className="vibe-canvas-host" aria-hidden="true" />
}
