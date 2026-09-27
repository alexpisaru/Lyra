import * as THREE from 'three'
import { ORB_PARAMS, type OrbParams, type OrbPulse, type OrbState } from './orbState'
import {
  CORE_VERTEX,
  GLOW_FRAGMENT,
  GLOW_VERTEX,
  POINT_FRAGMENT,
  SHELL_VERTEX,
  SPRAY_VERTEX,
  STAR_VERTEX,
  STREAK_VERTEX,
} from './orbShaders'

export type QualityTier = 'high' | 'medium' | 'low' | 'mini'

interface CurveSet {
  curves: number
  points: number
}

export interface Quality {
  tier: QualityTier
  shell: number
  core: number
  spray: number
  violet: CurveSet
  /** lightning-like luminous veins across the surface */
  veins: CurveSet
  arcs: CurveSet
  stars: number
  maxPixelRatio: number
}

// The shell (rim + veins) carries the look; streaks and arcs are few and fine.
export const QUALITY: Record<QualityTier, Quality> = {
  high: {
    tier: 'high', shell: 24000, core: 4500, spray: 3500, violet: { curves: 14, points: 150 }, veins: { curves: 56, points: 160 },
    arcs: { curves: 10, points: 1000 }, stars: 500, maxPixelRatio: 2,
  },
  medium: {
    tier: 'medium', shell: 14000, core: 2600, spray: 2000, violet: { curves: 10, points: 120 }, veins: { curves: 40, points: 130 },
    arcs: { curves: 8, points: 700 }, stars: 250, maxPixelRatio: 2,
  },
  low: {
    tier: 'low', shell: 8000, core: 1500, spray: 1200, violet: { curves: 8, points: 100 }, veins: { curves: 18, points: 100 },
    arcs: { curves: 6, points: 500 }, stars: 120, maxPixelRatio: 1.5,
  },
  mini: {
    tier: 'mini', shell: 6500, core: 900, spray: 700, violet: { curves: 7, points: 90 }, veins: { curves: 18, points: 90 },
    arcs: { curves: 7, points: 420 }, stars: 0, maxPixelRatio: 2,
  },
}

export function pickQuality(env: { coarsePointer: boolean; cores: number; memory?: number; minSide: number }): Quality {
  if (env.cores <= 2 || (env.memory !== undefined && env.memory <= 2)) return QUALITY.low
  if (env.coarsePointer || env.minSide < 700 || env.cores <= 4) return QUALITY.medium
  return QUALITY.high
}

/** Where and how large the orb sits (fractions of the canvas). */
export interface OrbFrame {
  /** orb diameter as a fraction of the shorter canvas side */
  size: number
  /** centre offset in [-1, 1] canvas units (x right, y up) */
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

function cloud(count: number, place: (i: number) => THREE.Vector3, rand: Rand) {
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    const v = place(i)
    positions.set([v.x, v.y, v.z], i * 3)
    seeds.set([rand(), rand(), rand()], i * 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3))
  return geometry
}

function fibonacci(count: number, rand: Rand) {
  const golden = Math.PI * (3 - Math.sqrt(5))
  return (i: number) => {
    const y = 1 - (i / (count - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = golden * i + rand() * 0.6
    return new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius)
  }
}

function strip(set: CurveSet, point: (curve: number, t: number) => THREE.Vector3, rand: Rand) {
  const n = set.curves * set.points
  const positions = new Float32Array(n * 3)
  const ts = new Float32Array(n)
  const curves = new Float32Array(n * 2)
  const seeds = new Float32Array(n)
  for (let c = 0; c < set.curves; c += 1) {
    const flow = rand()
    const life = rand()
    for (let i = 0; i < set.points; i += 1) {
      const t = i / (set.points - 1)
      const v = point(c, t)
      const k = c * set.points + i
      positions.set([v.x, v.y, v.z], k * 3)
      ts[k] = t
      curves.set([flow, life], k * 2)
      seeds[k] = rand()
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aT', new THREE.BufferAttribute(ts, 1))
  geometry.setAttribute('aCurve', new THREE.BufferAttribute(curves, 2))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  return geometry
}

/** Short violet streaks: smooth curves on the rim, some leaving it slightly. */
function violetStreaks(set: CurveSet, rand: Rand) {
  const paths: THREE.Vector3[][] = []
  for (let c = 0; c < set.curves; c += 1) {
    const dir = unit(rand)
    const tangent = unit(rand).cross(dir).normalize()
    let turn = (rand() - 0.5) * 0.04
    const phase = rand() * Math.PI * 2
    const step = 1.25 / set.points
    const path: THREE.Vector3[] = []
    for (let i = 0; i < set.points; i += 1) {
      turn = THREE.MathUtils.clamp(turn + (rand() - 0.5) * 0.02, -0.04, 0.04)
      tangent.applyAxisAngle(dir, turn)
      dir.addScaledVector(tangent, step).normalize()
      tangent.sub(dir.clone().multiplyScalar(tangent.dot(dir))).normalize()
      path.push(dir.clone().multiplyScalar(1.0 + 0.07 * Math.sin(phase + i * 0.06)))
    }
    paths.push(path)
  }
  return strip(set, (c, t) => paths[c][Math.round(t * (set.points - 1))], rand)
}

/** Crackling vein paths on the surface: short straight runs with sharp turns (lightning). */
function surfaceVeins(set: CurveSet, rand: Rand) {
  const paths: THREE.Vector3[][] = []
  for (let c = 0; c < set.curves; c += 1) {
    const dir = unit(rand)
    const tangent = unit(rand).cross(dir).normalize()
    const step = (0.7 + rand() * 0.5) / set.points
    const path: THREE.Vector3[] = []
    for (let i = 0; i < set.points; i += 1) {
      if (rand() < 0.08) tangent.applyAxisAngle(dir, (rand() - 0.5) * 1.6)
      dir.addScaledVector(tangent, step).normalize()
      tangent.sub(dir.clone().multiplyScalar(tangent.dot(dir))).normalize()
      path.push(dir.clone().multiplyScalar(1.0 + (rand() - 0.5) * 0.012))
    }
    paths.push(path)
  }
  return strip(set, (c, t) => paths[c][Math.round(t * (set.points - 1))], rand)
}

/** Long, smooth circular arcs in tilted planes, always outside the sphere. */
function arcs(set: CurveSet, rand: Rand) {
  const specs = Array.from({ length: set.curves }, () => ({
    radius: 1.05 + rand() * 0.4,
    start: rand() * Math.PI * 2,
    span: 1.8 + rand() * 2.4,
    rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI)),
  }))
  return strip(
    set,
    (c, t) => {
      const s = specs[c]
      const a = s.start + s.span * t
      return new THREE.Vector3(Math.cos(a) * s.radius, Math.sin(a) * s.radius, 0).applyQuaternion(s.rotation)
    },
    rand,
  )
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

/**
 * One orb: layers, shared uniforms, eased state and one-shot pulses. Used by
 * the hero scene and (at "mini" quality) by every "Stati principali" preview.
 * States never rebuild geometry: they move eased uniforms.
 */
export class OrbRig {
  readonly root = new THREE.Group() // framing: position + scale
  private readonly spin = new THREE.Group() // rotation only (the glow must not tilt)
  private readonly arcGroup = new THREE.Group()
  private readonly disposables: { dispose(): void }[] = []
  private readonly u: Uniforms
  private readonly glowUniforms: Uniforms
  private readonly violetUniforms: Uniforms
  private readonly veinUniforms: Uniforms
  private readonly arcUniforms: Uniforms[] = []
  private readonly sizes: { uniforms: Uniforms; base: number }[] = []
  private readonly current: OrbParams = { ...ORB_PARAMS.idle }
  private target: OrbParams = ORB_PARAMS.idle
  private time = 0
  private flowTime = 0
  private impulse = 0
  private wave = -1

  constructor(quality: Quality, rand: Rand) {
    this.u = {
      uTime: { value: 0 },
      uFlowTime: { value: 0 },
      uDeform: { value: 0.04 },
      uCore: { value: 0.15 },
      uPurple: { value: 0.75 },
      uVeins: { value: 0.9 },
      uAlternate: { value: 0 },
      uOrbit: { value: 0.15 },
      uCompress: { value: 0 },
      uDisperse: { value: 0.05 },
      uImpulse: { value: 0 },
      uWave: { value: -1 },
      uJitter: { value: 0 },
      uWarm: { value: 0 },
      uRhythm: { value: 0 },
      uArcSpread: { value: 1 },
      uPixelRatio: { value: 1 },
      uBrightness: { value: 1 },
      uSaturation: { value: 1 },
    }
    const u = this.u
    const points = (geometry: THREE.BufferGeometry, vertexShader: string, own: Uniforms, size: number, order: number, parent: THREE.Object3D) => {
      const uniforms: Uniforms = { ...u, uSize: { value: size }, ...own }
      const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader: POINT_FRAGMENT, uniforms, ...additive })
      const object = new THREE.Points(geometry, material)
      object.renderOrder = order
      parent.add(object)
      this.disposables.push(geometry, material)
      this.sizes.push({ uniforms, base: size })
      return uniforms
    }

    // Halo (behind everything, never tilts).
    this.glowUniforms = {
      uTime: u.uTime,
      uPurple: u.uPurple,
      uCore: u.uCore,
      uWave: u.uWave,
      uWarm: u.uWarm,
      uRhythm: u.uRhythm,
      uBrightness: u.uBrightness,
      uSaturation: u.uSaturation,
      uGlow: { value: 1 },
      uFlare: { value: 0 },
    }
    const glowGeometry = new THREE.PlaneGeometry(4.4, 4.4)
    const glowMaterial = new THREE.ShaderMaterial({ vertexShader: GLOW_VERTEX, fragmentShader: GLOW_FRAGMENT, uniforms: this.glowUniforms, ...additive })
    const glow = new THREE.Mesh(glowGeometry, glowMaterial)
    glow.scale.setScalar(2 / 2.2) // uv radius 1 == 2 world units, so d == radius in the shader
    glow.renderOrder = 0
    this.root.add(glow)
    this.disposables.push(glowGeometry, glowMaterial)

    const q = quality
    points(cloud(q.core, () => unit(rand).multiplyScalar(0.93 * Math.pow(rand(), 0.5)), rand), CORE_VERTEX, {}, 12, 1, this.spin)
    points(cloud(q.shell, fibonacci(q.shell, rand), rand), SHELL_VERTEX, {}, 12, 2, this.spin)
    points(cloud(q.spray, () => unit(rand), rand), SPRAY_VERTEX, {}, 11, 3, this.spin)

    const streak = (a: THREE.Color, b: THREE.Color, arc: boolean, head: number): Uniforms => ({
      uIntensity: { value: 1 },
      uColorA: { value: a },
      uColorB: { value: b },
      uHeadSpeed: { value: head },
      uIsArc: { value: arc ? 1 : 0 },
    })
    this.violetUniforms = points(
      violetStreaks(q.violet, rand),
      STREAK_VERTEX,
      streak(new THREE.Color(0.36, 0.24, 0.98), new THREE.Color(0.72, 0.5, 1.0), false, 0.2),
      20,
      4,
      this.spin,
    )
    this.veinUniforms = points(
      surfaceVeins(q.veins, rand),
      STREAK_VERTEX,
      streak(new THREE.Color(0.25, 0.7, 1.0), new THREE.Color(0.85, 0.97, 1.0), false, 0.35),
      26,
      4,
      this.spin,
    )
    // Arcs: mostly cyan-blue, one or two violet, as in the reference.
    const violetArcs = Math.max(1, Math.round(q.arcs.curves / 3))
    this.arcUniforms.push(
      points(
        arcs({ curves: q.arcs.curves - violetArcs, points: q.arcs.points }, rand),
        STREAK_VERTEX,
        streak(new THREE.Color(0.3, 0.66, 1.0), new THREE.Color(0.75, 0.95, 1.0), true, 0.12),
        20,
        5,
        this.arcGroup,
      ),
      points(
        arcs({ curves: violetArcs, points: q.arcs.points }, rand),
        STREAK_VERTEX,
        streak(new THREE.Color(0.4, 0.26, 0.95), new THREE.Color(0.72, 0.52, 1.0), true, 0.1),
        20,
        5,
        this.arcGroup,
      ),
    )
    this.spin.add(this.arcGroup)
    this.root.add(this.spin)
  }

  setState(state: OrbState) {
    this.target = ORB_PARAMS[state]
  }

  /** Jump straight to a state without easing (previews). */
  snapState(state: OrbState) {
    this.target = ORB_PARAMS[state]
    Object.assign(this.current, this.target)
  }

  /** One-shot events: out-pulse, softer in-pulse, response wave from the centre. */
  pulse(kind: OrbPulse) {
    if (kind === 'tool_started') this.impulse = 1
    else if (kind === 'tool_finished') this.impulse = -0.6
    else this.wave = 0
  }

  update(dt: number, opts: { motion: number; pixelRatio: number; sizeScale: number; presence: number; reducedMotion: boolean }) {
    const ease = 1 - Math.exp(-dt * 5.5) // ~450 ms transitions
    const cur = this.current as unknown as Record<string, number>
    const tgt = this.target as unknown as Record<string, number>
    for (const key of Object.keys(cur)) cur[key] += (tgt[key] - cur[key]) * ease
    const p = this.current
    const m = opts.motion
    this.time += dt * (0.25 + p.speed * 1.3) * m
    this.flowTime += dt * p.flow * m
    this.impulse *= Math.exp(-dt * 3.5)
    if (this.wave >= 0) {
      this.wave += dt / 0.95
      if (this.wave > 1) this.wave = -1
    }
    this.spin.rotation.y += dt * (0.03 + p.speed * 0.06) * m
    this.spin.rotation.x = 0.3 + Math.sin(this.time * 0.1) * 0.05
    this.arcGroup.rotation.y += dt * (0.04 + p.orbit * 0.5) * m
    this.arcGroup.rotation.z += dt * p.orbit * 0.1 * m

    const u = this.u
    u.uTime.value = this.time
    u.uFlowTime.value = this.flowTime
    u.uDeform.value = p.deform
    u.uCore.value = p.core
    u.uPurple.value = p.purple
    u.uVeins.value = p.veins
    u.uAlternate.value = p.alternate
    u.uOrbit.value = p.orbit
    u.uCompress.value = p.compression
    u.uDisperse.value = p.dispersion
    u.uImpulse.value = opts.reducedMotion ? 0 : this.impulse
    u.uWave.value = this.wave
    u.uJitter.value = p.jitter
    u.uWarm.value = p.warm
    u.uRhythm.value = opts.reducedMotion ? 0 : p.rhythm
    u.uArcSpread.value = p.arcSpread
    u.uPixelRatio.value = opts.pixelRatio
    u.uBrightness.value = p.brightness * (0.35 + 0.65 * opts.presence)
    u.uSaturation.value = p.saturation
    const outward = Math.max(0, this.impulse)
    this.glowUniforms.uGlow.value = p.glow * (1 + outward * 0.25)
    this.glowUniforms.uFlare.value = p.flare
    this.violetUniforms.uIntensity.value = p.purple * 1.1
    this.veinUniforms.uIntensity.value = p.veins * 1.3
    for (const uniforms of this.arcUniforms) uniforms.uIntensity.value = p.arcs * 3 * (1 + outward)
    for (const { uniforms, base } of this.sizes) uniforms.uSize.value = base * opts.sizeScale
  }

  dispose() {
    this.disposables.forEach((item) => item.dispose())
  }
}

function starField(count: number, rand: Rand) {
  return cloud(
    count,
    () => new THREE.Vector3((rand() * 2 - 1) * 10, (rand() * 2 - 1) * 5.5, -4 - rand() * 4),
    rand,
  )
}

export interface OrbSceneOptions {
  quality: Quality
  reducedMotion: boolean
  random?: Rand
}

function renderer(canvas: HTMLCanvasElement) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance', premultipliedAlpha: true })
  r.setClearColor(0x000000, 0)
  return r
}

/**
 * The hero orb: one canvas for the whole session; React only calls
 * setState / setFrame / pulse and dispose().
 */
export class OrbScene {
  readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50)
  private readonly rig: OrbRig
  private readonly disposables: { dispose(): void }[] = []
  private readonly starUniforms: Uniforms
  private frame: OrbFrame = { size: 0.5, x: 0, y: 0.08, presence: 1 }
  private frameNow: OrbFrame = { size: 0.5, x: 0, y: 0.08, presence: 1 }
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
    this.renderer = renderer(canvas)
    this.camera.position.set(0, 0, 6)
    this.rig = new OrbRig(this.quality, rand)
    this.scene.add(this.rig.root)

    this.starUniforms = { uTime: { value: 0 }, uSize: { value: 9 }, uPixelRatio: { value: 1 }, uBrightness: { value: 1 }, uSaturation: { value: 1 } }
    if (this.quality.stars > 0) {
      const geometry = starField(this.quality.stars, rand)
      const material = new THREE.ShaderMaterial({ vertexShader: STAR_VERTEX, fragmentShader: POINT_FRAGMENT, uniforms: this.starUniforms, ...additive })
      const stars = new THREE.Points(geometry, material)
      stars.renderOrder = -1
      this.scene.add(stars)
      this.disposables.push(geometry, material)
    }
  }

  setState(state: OrbState) {
    this.rig.setState(state)
  }

  /** New framing target; with `snap` it jumps there without easing (first frame). */
  setFrame(frame: OrbFrame, snap = false) {
    this.frame = frame
    if (snap) this.frameNow = { ...frame }
  }

  pulse(kind: OrbPulse) {
    this.rig.pulse(kind)
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

    const f = this.frameNow
    const fe = 1 - Math.exp(-dt * 3.2)
    f.size += (this.frame.size - f.size) * fe
    f.x += (this.frame.x - f.x) * fe
    f.y += (this.frame.y - f.y) * fe
    f.presence += (this.frame.presence - f.presence) * fe

    // Framing: a unit sphere spans `size` of the shorter canvas side.
    const visibleH = 2 * this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const visibleW = visibleH * this.camera.aspect
    this.rig.root.scale.setScalar((f.size * Math.min(visibleH, visibleW)) / 2)
    this.rig.root.position.set((f.x * visibleW) / 2, (f.y * visibleH) / 2, 0)
    const sizeScale = Math.max(0.4, (f.size * Math.min(this.width, this.height)) / 520)
    this.rig.update(dt, {
      motion: this.reducedMotion ? 0.12 : 1,
      pixelRatio: this.pixelRatio,
      sizeScale,
      presence: f.presence,
      reducedMotion: this.reducedMotion,
    })
    this.starUniforms.uTime.value += dt
    this.starUniforms.uPixelRatio.value = this.pixelRatio
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
    this.rig.dispose()
    this.disposables.forEach((item) => item.dispose())
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}

interface GalleryEntry {
  state: OrbState
  element: HTMLElement
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  rig: OrbRig
  nextPulse: number
  step: number
}

/**
 * The "Stati principali" previews: ONE renderer draws a mini orb into each
 * card slot with scissor rectangles (one WebGL context for all six). Response
 * and using_tool replay their one-shot events so the previews stay readable.
 */
export class OrbGallery {
  readonly renderer: THREE.WebGLRenderer
  private readonly entries: GalleryEntry[] = []
  private raf = 0
  private last = 0
  private running = false
  private pixelRatio = 1
  private readonly reducedMotion: boolean

  constructor(canvas: HTMLCanvasElement, slots: { state: OrbState; element: HTMLElement }[], options: { reducedMotion: boolean; random?: Rand }) {
    this.reducedMotion = options.reducedMotion
    const rand = options.random ?? Math.random
    this.renderer = renderer(canvas)
    this.renderer.autoClear = false
    for (const slot of slots) {
      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50)
      camera.position.set(0, 0, 6)
      const rig = new OrbRig(QUALITY.mini, rand)
      rig.snapState(slot.state)
      scene.add(rig.root)
      this.entries.push({ ...slot, scene, camera, rig, nextPulse: 0.6 + rand(), step: 0 })
    }
  }

  resize(width: number, height: number, devicePixelRatio: number) {
    this.pixelRatio = Math.min(devicePixelRatio, 2)
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.setSize(Math.max(1, width), Math.max(1, height), false)
  }

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    const loop = (now: number) => {
      if (!this.running) return
      this.raf = requestAnimationFrame(loop)
      // ~30 fps is plenty for small previews.
      if (now - this.last < 32) return
      this.tick(now)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  private tick(now: number) {
    const dt = Math.min((now - this.last) / 1000, 0.1)
    this.last = now
    const canvas = this.renderer.domElement
    const box = canvas.getBoundingClientRect()
    this.renderer.setScissorTest(false)
    this.renderer.clear()
    this.renderer.setScissorTest(true)
    for (const e of this.entries) {
      this.replay(e, dt)
      const r = e.element.getBoundingClientRect()
      const w = r.width
      const h = r.height
      if (w < 2 || h < 2 || r.bottom < box.top || r.top > box.bottom) continue
      const x = r.left - box.left
      const y = box.bottom - r.bottom
      this.renderer.setViewport(x, y, w, h)
      this.renderer.setScissor(x, y, w, h)
      e.camera.aspect = w / h
      e.camera.updateProjectionMatrix()
      const visibleH = 2 * e.camera.position.z * Math.tan(THREE.MathUtils.degToRad(e.camera.fov / 2))
      const minVisible = Math.min(visibleH, visibleH * e.camera.aspect)
      e.rig.root.scale.setScalar((0.62 * minVisible) / 2)
      e.rig.update(dt, {
        motion: this.reducedMotion ? 0.12 : 1,
        pixelRatio: this.pixelRatio,
        sizeScale: Math.max(0.3, (0.62 * Math.min(w, h)) / 520),
        presence: 1,
        reducedMotion: this.reducedMotion,
      })
      this.renderer.render(e.scene, e.camera)
    }
  }

  private replay(e: GalleryEntry, dt: number) {
    if (e.state !== 'response' && e.state !== 'using_tool') return
    e.nextPulse -= dt
    if (e.nextPulse > 0) return
    if (e.state === 'response') {
      e.rig.pulse('response')
      e.nextPulse = 2.6
    } else if (e.step === 0) {
      e.rig.pulse('tool_started')
      e.step = 1
      e.nextPulse = 0.5
    } else {
      e.rig.pulse('tool_finished')
      e.step = 0
      e.nextPulse = 2.0
    }
  }

  dispose() {
    this.stop()
    this.entries.forEach((e) => e.rig.dispose())
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}
