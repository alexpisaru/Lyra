import * as THREE from 'three'
import { ORB_PARAMS, type OrbParams, type OrbPulse, type OrbState } from './orbState'
import {
  FILAMENT_VERTEX,
  GLOW_FRAGMENT,
  GLOW_VERTEX,
  POINT_FRAGMENT,
  SHELL_VERTEX,
  STAR_VERTEX,
  VOLUME_VERTEX,
} from './orbShaders'

export type QualityTier = 'high' | 'medium' | 'low'

interface CurveSet {
  curves: number
  points: number
}

export interface Quality {
  tier: QualityTier
  shell: number
  volume: number
  cyan: CurveSet
  violet: CurveSet
  arcs: CurveSet
  stars: number
  maxPixelRatio: number
}

// Filaments and the violet layer come first; raw particle count is the last priority.
export const QUALITY: Record<QualityTier, Quality> = {
  high: {
    tier: 'high', shell: 12000, volume: 5000, cyan: { curves: 36, points: 270 },
    violet: { curves: 16, points: 290 }, arcs: { curves: 10, points: 200 }, stars: 600, maxPixelRatio: 2,
  },
  medium: {
    tier: 'medium', shell: 7000, volume: 2800, cyan: { curves: 26, points: 210 },
    violet: { curves: 12, points: 230 }, arcs: { curves: 8, points: 160 }, stars: 300, maxPixelRatio: 2,
  },
  low: {
    tier: 'low', shell: 4000, volume: 1500, cyan: { curves: 18, points: 170 },
    violet: { curves: 8, points: 190 }, arcs: { curves: 6, points: 130 }, stars: 150, maxPixelRatio: 1.5,
  },
}

export function pickQuality(env: { coarsePointer: boolean; cores: number; memory?: number; minSide: number }): Quality {
  if (env.cores <= 2 || (env.memory !== undefined && env.memory <= 2)) return QUALITY.low
  if (env.coarsePointer || env.minSide < 700 || env.cores <= 4) return QUALITY.medium
  return QUALITY.high
}

/** Where and how large the orb sits for each screen (fractions of the viewport). */
export interface OrbFrame {
  /** orb diameter as a fraction of the shorter viewport side */
  size: number
  /** centre offset in [-1, 1] viewport units (x right, y up) */
  x: number
  y: number
  /** 1 = full presence, lower = ambient */
  presence: number
}

type Uniforms = Record<string, THREE.IUniform>
type Rand = () => number

function unit(rand: Rand) {
  const u = rand() * 2 - 1
  const phi = rand() * Math.PI * 2
  const s = Math.sqrt(1 - u * u)
  return new THREE.Vector3(Math.cos(phi) * s, u, Math.sin(phi) * s)
}

function shellPoints(count: number, rand: Rand) {
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = golden * i + rand() * 0.5
    positions.set([Math.cos(theta) * radius, y, Math.sin(theta) * radius], i * 3)
    seeds.set([rand(), rand(), rand()], i * 3)
  }
  return { positions, seeds }
}

function volumePoints(count: number, rand: Rand) {
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    const r = 0.92 * Math.pow(rand(), 0.55)
    const d = unit(rand).multiplyScalar(r)
    positions.set([d.x, d.y, d.z], i * 3)
    seeds.set([rand(), rand(), rand()], i * 3)
  }
  return { positions, seeds }
}

interface CurveStyle {
  length: number
  radius: number
  radiusAmp: number
  radiusFreq: number
  wander: number
  maxTurn: number
}

function strip(positions: Float32Array, ts: Float32Array, curve: Float32Array, seeds: Float32Array) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aT', new THREE.BufferAttribute(ts, 1))
  geometry.setAttribute('aCurve', new THREE.BufferAttribute(curve, 2))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  return geometry
}

/**
 * An organic filament: a walk over the sphere whose curvature wanders smoothly
 * (never a great circle), with a radius that breathes in and out of the surface.
 */
function filamentPoints(set: CurveSet, style: CurveStyle, rand: Rand) {
  const n = set.curves * set.points
  const positions = new Float32Array(n * 3)
  const ts = new Float32Array(n)
  const curve = new Float32Array(n * 2)
  const seeds = new Float32Array(n)
  const projection = new THREE.Vector3()
  for (let c = 0; c < set.curves; c += 1) {
    const dir = unit(rand)
    const tangent = unit(rand).cross(dir).normalize()
    let turn = (rand() - 0.5) * style.maxTurn
    const phase = rand() * Math.PI * 2
    const step = style.length / set.points
    const flow = rand()
    const life = rand()
    for (let i = 0; i < set.points; i += 1) {
      turn = THREE.MathUtils.clamp(turn + (rand() - 0.5) * style.wander, -style.maxTurn, style.maxTurn)
      tangent.applyAxisAngle(dir, turn)
      dir.addScaledVector(tangent, step).normalize()
      projection.copy(dir).multiplyScalar(tangent.dot(dir))
      tangent.sub(projection).normalize()
      const r = style.radius + style.radiusAmp * Math.sin(phase + i * style.radiusFreq)
      const k = c * set.points + i
      positions.set([dir.x * r, dir.y * r, dir.z * r], k * 3)
      ts[k] = i / (set.points - 1)
      curve.set([flow, life], k * 2)
      seeds[k] = rand()
    }
  }
  return strip(positions, ts, curve, seeds)
}

/** External arcs: leave the surface at A, swing out, re-enter at B. */
function arcPoints(set: CurveSet, rand: Rand) {
  const n = set.curves * set.points
  const positions = new Float32Array(n * 3)
  const ts = new Float32Array(n)
  const curve = new Float32Array(n * 2)
  const seeds = new Float32Array(n)
  const p = new THREE.Vector3()
  for (let c = 0; c < set.curves; c += 1) {
    const a = unit(rand)
    const perpendicular = unit(rand).cross(a).normalize()
    const b = a.clone().applyAxisAngle(perpendicular, 0.7 + rand() * 1.3)
    const side = new THREE.Vector3().crossVectors(a, b).normalize()
    const height = 0.14 + rand() * 0.34
    const lean = (rand() - 0.5) * 0.35
    const flow = rand()
    const life = rand()
    for (let i = 0; i < set.points; i += 1) {
      const t = i / (set.points - 1)
      p.copy(a).lerp(b, t).normalize()
      p.addScaledVector(side, lean * Math.sin(Math.PI * t) * Math.sin(Math.PI * t * 2)).normalize()
      const r = 0.98 + height * Math.sin(Math.PI * t)
      const k = c * set.points + i
      positions.set([p.x * r, p.y * r, p.z * r], k * 3)
      ts[k] = t
      curve.set([flow, life], k * 2)
      seeds[k] = rand()
    }
  }
  return strip(positions, ts, curve, seeds)
}

function cloud(data: { positions: Float32Array; seeds: Float32Array }) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(data.seeds, 3))
  return geometry
}

// Pure light: add colour, keep the canvas alpha at 0 so the CSS backdrop shows through.
const additive = {
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
} as const

export interface OrbSceneOptions {
  quality: Quality
  reducedMotion: boolean
  random?: Rand
}

/**
 * Imperative Three.js scene. One instance lives for the whole app session;
 * React only calls setState / setFrame / pulse and dispose(). States never
 * rebuild geometry: they move eased uniforms.
 */
export class OrbScene {
  readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50)
  private readonly orb = new THREE.Group() // framing: position + scale
  private readonly spin = new THREE.Group() // rotation only (the glow must not tilt)
  private readonly arcGroup = new THREE.Group()
  private readonly disposables: { dispose(): void }[] = []
  private readonly u: Uniforms
  private readonly glowUniforms: Uniforms
  private readonly violetUniforms: Uniforms
  private readonly arcCyanUniforms: Uniforms
  private readonly arcVioletUniforms: Uniforms
  private readonly sizes: { uniforms: Uniforms; base: number }[] = []
  private readonly current: OrbParams = { ...ORB_PARAMS.idle }
  private target: OrbParams = ORB_PARAMS.idle
  private frame: OrbFrame = { size: 0.5, x: 0, y: 0.08, presence: 1 }
  private frameNow: OrbFrame = { size: 0.5, x: 0, y: 0.08, presence: 1 }
  private time = 0
  private flowTime = 0
  private impulse = 0
  private wave = -1
  private raf = 0
  private last = 0
  private width = 1
  private height = 1
  private pixelRatio = 1
  private slowFrames = 0
  private running = false
  private readonly quality: Quality
  private readonly reducedMotion: boolean

  constructor(canvas: HTMLCanvasElement, options: OrbSceneOptions) {
    this.quality = options.quality
    this.reducedMotion = options.reducedMotion
    const rand = options.random ?? Math.random
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
    })
    this.renderer.setClearColor(0x000000, 0)
    this.camera.position.set(0, 0, 6)

    // Shared uniform objects: every layer reads the same eased state.
    this.u = {
      uTime: { value: 0 },
      uFlowTime: { value: 0 },
      uDeform: { value: 0.05 },
      uCore: { value: 0.1 },
      uPurple: { value: 0.6 },
      uAlternate: { value: 0 },
      uOrbit: { value: 0.15 },
      uCompress: { value: 0 },
      uDisperse: { value: 0.05 },
      uImpulse: { value: 0 },
      uWave: { value: -1 },
      uJitter: { value: 0 },
      uHueShift: { value: 0 },
      uPixelRatio: { value: 1 },
      uBrightness: { value: 1 },
      uSaturation: { value: 1 },
    }
    const u = this.u

    const points = (
      geometry: THREE.BufferGeometry,
      vertexShader: string,
      own: Uniforms,
      size: number,
      order: number,
      parent: THREE.Object3D,
    ) => {
      const uniforms: Uniforms = { ...u, uSize: { value: size }, ...own }
      const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader: POINT_FRAGMENT, uniforms, ...additive })
      const object = new THREE.Points(geometry, material)
      object.renderOrder = order
      parent.add(object)
      this.disposables.push(geometry, material)
      this.sizes.push({ uniforms, base: size })
      return uniforms
    }

    // Layer 6 — halo (behind everything, never tilts).
    this.glowUniforms = {
      uTime: u.uTime,
      uPurple: u.uPurple,
      uCore: u.uCore,
      uWave: u.uWave,
      uHueShift: u.uHueShift,
      uBrightness: u.uBrightness,
      uSaturation: u.uSaturation,
      uGlow: { value: 0.85 },
    }
    const glowGeometry = new THREE.PlaneGeometry(4.4, 4.4)
    const glowMaterial = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      uniforms: this.glowUniforms,
      ...additive,
    })
    const glow = new THREE.Mesh(glowGeometry, glowMaterial)
    glow.scale.setScalar(2 / 2.2) // uv radius 1 == 2 world units, so d == radius in the shader
    glow.renderOrder = 0
    this.orb.add(glow)
    this.disposables.push(glowGeometry, glowMaterial)

    const q = this.quality
    // Layer 1 — inner volume.
    points(cloud(volumePoints(q.volume, rand)), VOLUME_VERTEX, {}, 18, 1, this.spin)
    // Layer 4 — surface cloud.
    points(cloud(shellPoints(q.shell, rand)), SHELL_VERTEX, {}, 16, 2, this.spin)

    const filamentUniforms = (a: THREE.Color, b: THREE.Color, violet: boolean, arc: boolean, head: number): Uniforms => ({
      uIntensity: { value: 1 },
      uColorA: { value: a },
      uColorB: { value: b },
      uHeadSpeed: { value: head },
      uLife: { value: arc ? 1 : 0 },
      uIsViolet: { value: violet ? 1 : 0 },
      uArcMode: { value: arc ? 1 : 0 },
    })
    const cyanA = new THREE.Color(0.26, 0.72, 1.0)
    const cyanB = new THREE.Color(0.75, 0.95, 1.0)
    const violetA = new THREE.Color(0.34, 0.24, 0.95)
    const violetB = new THREE.Color(0.7, 0.45, 1.0)

    // Layer 2 — cyan filaments: mostly on the surface, gently dipping in.
    points(
      filamentPoints(q.cyan, { length: 2.5, radius: 0.97, radiusAmp: 0.06, radiusFreq: 0.05, wander: 0.05, maxTurn: 0.035 }, rand),
      FILAMENT_VERTEX,
      filamentUniforms(cyanA, cyanB, false, false, 0.18),
      24,
      3,
      this.spin,
    )
    // Layer 3 — violet energy layer: fewer, curvier, crossing the interior and sometimes leaving it.
    this.violetUniforms = points(
      filamentPoints(q.violet, { length: 3.1, radius: 0.8, radiusAmp: 0.26, radiusFreq: 0.035, wander: 0.08, maxTurn: 0.06 }, rand),
      FILAMENT_VERTEX,
      filamentUniforms(violetA, violetB, true, false, 0.12),
      30,
      4,
      this.spin,
    )
    // Layer 5 — external arcs (half cyan, half violet), born and fading in cycles.
    const cyanArcs = Math.ceil(q.arcs.curves / 2)
    this.arcCyanUniforms = points(
      arcPoints({ curves: cyanArcs, points: q.arcs.points }, rand),
      FILAMENT_VERTEX,
      filamentUniforms(cyanA, cyanB, false, true, 0.3),
      26,
      5,
      this.arcGroup,
    )
    this.arcVioletUniforms = points(
      arcPoints({ curves: q.arcs.curves - cyanArcs, points: q.arcs.points }, rand),
      FILAMENT_VERTEX,
      filamentUniforms(violetA, violetB, true, true, 0.22),
      28,
      5,
      this.arcGroup,
    )
    this.spin.add(this.arcGroup)
    this.orb.add(this.spin)
    this.scene.add(this.orb)

    // Faint distant stars, independent from the orb framing.
    const starData = volumePoints(q.stars, rand)
    for (let i = 0; i < starData.positions.length; i += 3) {
      starData.positions[i] *= 10
      starData.positions[i + 1] *= 5.5
      starData.positions[i + 2] = -4 - Math.abs(starData.positions[i + 2]) * 4
    }
    const starGeometry = cloud(starData)
    const starMaterial = new THREE.ShaderMaterial({
      vertexShader: STAR_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      uniforms: {
        uTime: u.uTime,
        uSize: { value: 9 },
        uPixelRatio: u.uPixelRatio,
        uBrightness: u.uBrightness,
        uSaturation: u.uSaturation,
      },
      ...additive,
    })
    const stars = new THREE.Points(starGeometry, starMaterial)
    stars.renderOrder = -1
    this.scene.add(stars)
    this.disposables.push(starGeometry, starMaterial)
  }

  setState(state: OrbState) {
    this.target = ORB_PARAMS[state]
  }

  /** New framing target; with `snap` it jumps there without easing (first frame). */
  setFrame(frame: OrbFrame, snap = false) {
    this.frame = frame
    if (snap) this.frameNow = { ...frame }
  }

  /** One-shot events: out-pulse, softer in-pulse, response wave from the centre. */
  pulse(kind: OrbPulse) {
    if (kind === 'tool_started') this.impulse = 1
    else if (kind === 'tool_finished') this.impulse = -0.6
    else this.wave = 0
  }

  resize(width: number, height: number, devicePixelRatio: number) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.pixelRatio = Math.min(devicePixelRatio, this.quality.maxPixelRatio)
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.setSize(this.width, this.height, false)
    this.camera.aspect = this.width / this.height
    this.camera.updateProjectionMatrix()
  }

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    const loop = (now: number) => {
      if (!this.running) return
      this.raf = requestAnimationFrame(loop)
      this.tick(now)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  private tick(now: number) {
    const raw = (now - this.last) / 1000
    // Reduced motion: ~20 fps is plenty for an almost still orb.
    if (this.reducedMotion && raw < 0.05) return
    this.last = now
    const dt = Math.min(raw, 0.1)
    this.adapt(raw)

    // ~450 ms transitions between states.
    const ease = 1 - Math.exp(-dt * 5.5)
    const cur = this.current as unknown as Record<string, number>
    const tgt = this.target as unknown as Record<string, number>
    for (const key of Object.keys(cur)) cur[key] += (tgt[key] - cur[key]) * ease
    const f = this.frameNow
    const fe = 1 - Math.exp(-dt * 3.2)
    f.size += (this.frame.size - f.size) * fe
    f.x += (this.frame.x - f.x) * fe
    f.y += (this.frame.y - f.y) * fe
    f.presence += (this.frame.presence - f.presence) * fe

    const motion = this.reducedMotion ? 0.12 : 1
    const p = this.current
    this.time += dt * (0.25 + p.speed * 1.3) * motion
    this.flowTime += dt * p.flow * motion
    this.impulse *= Math.exp(-dt * 3.5)
    if (this.wave >= 0) {
      this.wave += dt / 0.95
      if (this.wave > 1) this.wave = -1
    }

    // Framing: a unit sphere spans `size` of the shorter viewport side.
    const visibleH = 2 * this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const visibleW = visibleH * this.camera.aspect
    this.orb.scale.setScalar((f.size * Math.min(visibleH, visibleW)) / 2)
    this.orb.position.set((f.x * visibleW) / 2, (f.y * visibleH) / 2, 0)
    this.spin.rotation.y += dt * (0.035 + p.speed * 0.07) * motion
    this.spin.rotation.x = 0.35 + Math.sin(this.time * 0.1) * 0.05
    this.arcGroup.rotation.y += dt * (0.04 + p.orbit * 0.55) * motion
    this.arcGroup.rotation.z += dt * p.orbit * 0.12 * motion

    const u = this.u
    u.uTime.value = this.time
    u.uFlowTime.value = this.flowTime
    u.uDeform.value = p.deform
    u.uCore.value = p.core
    u.uPurple.value = p.purple
    u.uAlternate.value = p.alternate
    u.uOrbit.value = p.orbit
    u.uCompress.value = p.compression
    u.uDisperse.value = p.dispersion
    u.uImpulse.value = this.reducedMotion ? 0 : this.impulse
    u.uWave.value = this.wave
    u.uJitter.value = p.jitter
    u.uHueShift.value = p.hueShift
    u.uPixelRatio.value = this.pixelRatio
    u.uBrightness.value = p.brightness * (0.35 + 0.65 * f.presence)
    u.uSaturation.value = p.saturation
    const outward = Math.max(0, this.impulse)
    this.glowUniforms.uGlow.value = p.glow * (1 + outward * 0.25)
    this.violetUniforms.uIntensity.value = p.purple * 1.6
    this.arcCyanUniforms.uIntensity.value = p.arcs * 1.4 * (1 + outward)
    this.arcVioletUniforms.uIntensity.value = p.arcs * p.purple * 1.6 * (1 + outward * 0.6)

    // Point sizes follow the on-screen orb size so a small orb stays crisp.
    const sizeScale = Math.max(0.4, (f.size * Math.min(this.width, this.height)) / 520)
    for (const { uniforms, base } of this.sizes) uniforms.uSize.value = base * sizeScale

    this.renderer.render(this.scene, this.camera)
  }

  /** Dynamic resolution: sustained slow frames lower the pixel ratio (never below 1). */
  private adapt(frameSeconds: number) {
    if (this.reducedMotion) return
    if (frameSeconds > 0.028 && frameSeconds < 0.5) this.slowFrames += 1
    else this.slowFrames = Math.max(0, this.slowFrames - 1)
    if (this.slowFrames > 90 && this.pixelRatio > 1) {
      this.slowFrames = 0
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25)
      this.renderer.setPixelRatio(this.pixelRatio)
      this.renderer.setSize(this.width, this.height, false)
    }
  }

  dispose() {
    this.stop()
    this.disposables.forEach((item) => item.dispose())
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}
