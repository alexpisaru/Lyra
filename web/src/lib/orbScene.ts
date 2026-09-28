import * as THREE from 'three'
import { ORB_PARAMS, type OrbParams, type OrbPulse, type OrbState } from './orbState'
import { RingMorph } from './ringMorph'
import {
  CORE_VERTEX,
  DISCHARGE_VERTEX,
  GLOW_FRAGMENT,
  GLOW_VERTEX,
  POINT_FRAGMENT,
  SHELL_VERTEX,
  SPRAY_VERTEX,
  STAR_VERTEX,
  TRAIL_FRAGMENT,
  TRAIL_VERTEX,
} from './orbShaders'

export type QualityTier = 'high' | 'medium' | 'low'

export interface Quality {
  tier: QualityTier
  shell: number
  core: number
  spray: number
  /** energy mesh: nodes on the sphere, links to the nearest neighbours, points per radian of link */
  web: { nodes: number; links: number; density: number }
  /** a few bold main strands drawn over the fine net (big cells) */
  strands: { nodes: number; links: number; density: number }
  /** open energy trails (soft ribbons) x segments per trail */
  trails: { count: number; segments: number }
  stars: number
  maxPixelRatio: number
}

// The look: crisp dense rim + an energy web over the whole sphere + lots of bright particles.
export const QUALITY: Record<QualityTier, Quality> = {
  high: {
    tier: 'high', shell: 20000, core: 8000, spray: 14000, web: { nodes: 1900, links: 3, density: 230 }, strands: { nodes: 70, links: 2, density: 200 },
    trails: { count: 14, segments: 96 }, stars: 160, maxPixelRatio: 2,
  },
  medium: {
    tier: 'medium', shell: 16000, core: 5000, spray: 6500, web: { nodes: 1200, links: 3, density: 170 }, strands: { nodes: 55, links: 2, density: 150 },
    trails: { count: 10, segments: 72 }, stars: 250, maxPixelRatio: 2,
  },
  low: {
    tier: 'low', shell: 9000, core: 2800, spray: 3000, web: { nodes: 650, links: 3, density: 120 }, strands: { nodes: 40, links: 2, density: 110 },
    trails: { count: 7, segments: 56 }, stars: 120, maxPixelRatio: 1.5,
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

/**
 * Energy mesh (the reference's net, not a tangle): bright nodes spread over the
 * sphere, each linked to its nearest neighbours by a short, slightly jagged
 * filament, so the links close into irregular cells.
 * Per point: aT along its link, aSeg = (link id, 1 for a node), aSeed.
 */
function energyWeb(q: Quality['web'], rand: Rand) {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const nodes: THREE.Vector3[] = []
  for (let i = 0; i < q.nodes; i += 1) {
    // fibonacci spread + jitter: even coverage, irregular cells
    const y = 1 - ((i + 0.5) / q.nodes) * 2
    const r = Math.sqrt(1 - y * y)
    const th = golden * i
    const v = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r)
    v.add(unit(rand).multiplyScalar(0.07 + rand() * 0.05)).normalize()
    nodes.push(v)
  }
  const pts: { v: THREE.Vector3; t: number; id: number; node: number }[] = []
  const seen = new Set<string>()
  nodes.forEach((a, i) => {
    pts.push({ v: a.clone(), t: 0.5, id: rand(), node: 1 })
    const nearest = nodes
      .map((b, j) => ({ j, d: a.distanceToSquared(b) }))
      .filter((e) => e.j !== i)
      .sort((x, y) => x.d - y.d)
      .slice(0, q.links + (rand() < 0.3 ? 1 : 0))
    for (const { j } of nearest) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`
      if (seen.has(key) || rand() < 0.12) continue
      seen.add(key)
      const b = nodes[j]
      const length = a.angleTo(b)
      const count = Math.max(6, Math.round(length * q.density))
      // a little sideways bend and jag, never a perfect straight line
      const side = a.clone().cross(b).normalize()
      const bend = (rand() - 0.5) * 0.2 * length
      const id = rand()
      for (let k = 0; k < count; k += 1) {
        const t = k / (count - 1)
        const jag = (rand() - 0.5) * 0.012 * length
        const v = a.clone().lerp(b, t).addScaledVector(side, (bend * Math.sin(Math.PI * t)) + jag).normalize()
        pts.push({ v, t, id, node: 0 })
      }
    }
  })
  const n = pts.length
  const positions = new Float32Array(n * 3)
  const ts = new Float32Array(n)
  const segs = new Float32Array(n * 2)
  const seeds = new Float32Array(n)
  pts.forEach((pt, k) => {
    positions.set([pt.v.x, pt.v.y, pt.v.z], k * 3)
    ts[k] = pt.t
    segs.set([pt.id, pt.node], k * 2)
    seeds[k] = rand()
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aT', new THREE.BufferAttribute(ts, 1))
  geometry.setAttribute('aSeg', new THREE.BufferAttribute(segs, 2))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  return geometry
}

/**
 * Energy trails as ribbons: two vertices per step (one each side). The path
 * itself is computed in TRAIL_VERTEX so trails can grow, sway and be reborn.
 */
function trails(q: Quality['trails'], rand: Rand) {
  const perTrail = (q.segments + 1) * 2
  const n = q.count * perTrail
  const pos = new Float32Array(n * 3)
  const ts = new Float32Array(n)
  const sides = new Float32Array(n)
  const roots = new Float32Array(n * 3)
  const tangents = new Float32Array(n * 3)
  const info = new Float32Array(n * 4)
  const shape = new Float32Array(n * 2)
  const index: number[] = []
  for (let c = 0; c < q.count; c += 1) {
    // roots on the upper/side part of the sphere; trails mostly sweep sideways
    let root = unit(rand)
    if (root.y < -0.3) root.y = -root.y
    root = root.normalize()
    const sideways = new THREE.Vector3().crossVectors(root, new THREE.Vector3(0, 1, 0))
    if (sideways.lengthSq() < 1e-4) sideways.set(1, 0, 0)
    sideways.normalize().multiplyScalar(rand() < 0.5 ? -1 : 1)
    const tangent = sideways.addScaledVector(unit(rand), 0.35)
    tangent.sub(root.clone().multiplyScalar(tangent.dot(root))).normalize()
    const id = rand()
    const violet = c % 3 === 1 ? 1 : 0
    const length = 0.7 + rand() * 0.9
    const curvature = 0.6 + rand() * 0.9
    const lift = 0.25 + rand() * 0.55
    const width = 0.06 + rand() * 0.06
    const base = c * perTrail
    for (let i = 0; i <= q.segments; i += 1) {
      for (let side = 0; side < 2; side += 1) {
        const k = base + i * 2 + side
        pos.set([root.x, root.y, root.z], k * 3)
        ts[k] = i / q.segments
        sides[k] = side === 0 ? -1 : 1
        roots.set([root.x, root.y, root.z], k * 3)
        tangents.set([tangent.x, tangent.y, tangent.z], k * 3)
        info.set([id, violet, length, curvature], k * 4)
        shape.set([lift, width], k * 2)
      }
      if (i < q.segments) {
        const a0 = base + i * 2
        index.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('aT', new THREE.BufferAttribute(ts, 1))
  geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1))
  geometry.setAttribute('aRoot', new THREE.BufferAttribute(roots, 3))
  geometry.setAttribute('aTangent', new THREE.BufferAttribute(tangents, 3))
  geometry.setAttribute('aTrail', new THREE.BufferAttribute(info, 4))
  geometry.setAttribute('aShape', new THREE.BufferAttribute(shape, 2))
  geometry.setIndex(index)
  return geometry
}

// Look switches (kept so a removed element can be restored in one place).
/** outer energy trails around the sphere */
const SHOW_TRAILS = false
/** bright cyan ring along the silhouette: 1 = full, 0 = none (the mesh still marks the edge) */
const RIM_RING = 0
/** translucent cyan body filling the sphere: 1 = on, 0 = off (only the net and particles remain) */
const BODY_FILL = 0

/** Linear mix of two parameter sets (the animation borrows the thinking energy). */
function mixParams(a: OrbParams, b: OrbParams, k: number): OrbParams {
  const out = { ...a }
  const o = out as unknown as Record<string, number>
  const x = a as unknown as Record<string, number>
  const y = b as unknown as Record<string, number>
  for (const key of Object.keys(o)) o[key] = x[key] + (y[key] - x[key]) * k
  return out
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
 * One orb: layers, shared uniforms, eased state and one-shot pulses.
 * States never rebuild geometry: they move eased uniforms.
 */
export class OrbRig {
  readonly root = new THREE.Group() // framing: position + scale
  private readonly spin = new THREE.Group() // rotation only (the glow must not tilt)
  private readonly arcGroup = new THREE.Group()
  private readonly disposables: { dispose(): void }[] = []
  private readonly u: Uniforms
  private readonly glowUniforms: Uniforms
  private readonly glow: THREE.Mesh
  private readonly arcUniforms: Uniforms
  private readonly sizes: { uniforms: Uniforms; base: number }[] = []
  private readonly current: OrbParams = { ...ORB_PARAMS.idle }
  private target: OrbParams = ORB_PARAMS.idle
  private time = 0
  private flowTime = 0
  private impulse = 0
  private wave = -1
  private afterglow = 0
  // thinking / using_tool: the orb breaks apart into a spinning ring (see ringMorph.ts)
  private readonly ring = new RingMorph()
  private working = false

  constructor(quality: Quality, rand: Rand) {
    this.u = {
      uTime: { value: 0 },
      uFlowTime: { value: 0 },
      uDeform: { value: 0.04 },
      uCore: { value: 0.15 },
      uPurple: { value: 0.75 },
      uPlasma: { value: 0.35 },
      uDischarge: { value: 0.85 },
      uAlternate: { value: 0 },
      uOrbit: { value: 0.15 },
      uCompress: { value: 0 },
      uDisperse: { value: 0.05 },
      uImpulse: { value: 0 },
      uWave: { value: -1 },
      uAfterglow: { value: 0 },
      uJitter: { value: 0 },
      uWarm: { value: 0 },
      uRhythm: { value: 0 },
      uFluxReach: { value: 1 },
      uRim: { value: RIM_RING },
      uMorph: { value: 0 },
      uShrink: { value: 1 },
      uScatter: { value: 0 },
      uFlatten: { value: 0 },
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
      object.frustumCulled = false
      parent.add(object)
      this.disposables.push(geometry, material)
      this.sizes.push({ uniforms, base: size })
      return uniforms
    }

    // Halo (behind everything, never tilts).
    this.glowUniforms = {
      uTime: u.uTime,
      uPurple: u.uPurple,
      uWave: u.uWave,
      uWarm: u.uWarm,
      uRhythm: u.uRhythm,
      uAfterglow: u.uAfterglow,
      uBrightness: u.uBrightness,
      uSaturation: u.uSaturation,
      uGlow: { value: 1 },
      uRim: u.uRim,
      uFill: { value: BODY_FILL },
      uMorph: u.uMorph,
    }
    const glowGeometry = new THREE.PlaneGeometry(4.4, 4.4)
    const glowMaterial = new THREE.ShaderMaterial({ vertexShader: GLOW_VERTEX, fragmentShader: GLOW_FRAGMENT, uniforms: this.glowUniforms, ...additive })
    const glow = new THREE.Mesh(glowGeometry, glowMaterial)
    this.glow = glow
    glow.scale.setScalar(2 / 2.2) // uv radius 1 == 2 world units, so d == radius in the shader
    glow.renderOrder = 0
    this.root.add(glow)
    this.disposables.push(glowGeometry, glowMaterial)

    const q = quality
    points(cloud(q.core, () => unit(rand).multiplyScalar(0.95 * Math.pow(rand(), 0.45)), rand), CORE_VERTEX, {}, 12, 1, this.spin)
    points(cloud(q.shell, fibonacci(q.shell, rand), rand), SHELL_VERTEX, {}, 12, 2, this.spin)
    points(energyWeb(q.web, rand), DISCHARGE_VERTEX, { uWeight: { value: 1 } }, 17, 3, this.spin)
    points(energyWeb(q.strands, rand), DISCHARGE_VERTEX, { uWeight: { value: 1.3 } }, 22, 3, this.spin)
    points(cloud(q.spray, () => unit(rand), rand), SPRAY_VERTEX, {}, 15, 4, this.spin)
    // energy trails: soft ribbons (a mesh, not points)
    this.arcUniforms = { ...u, uSize: { value: 1 }, uIntensity: { value: 1 } }
    const trailGeometry = trails(q.trails, rand)
    const trailMaterial = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERTEX,
      fragmentShader: TRAIL_FRAGMENT,
      uniforms: this.arcUniforms,
      ...additive,
      side: THREE.DoubleSide,
    })
    const trailMesh = new THREE.Mesh(trailGeometry, trailMaterial)
    trailMesh.frustumCulled = false
    trailMesh.renderOrder = 5
    if (SHOW_TRAILS) this.arcGroup.add(trailMesh)
    this.disposables.push(trailGeometry, trailMaterial)
    this.spin.add(this.arcGroup)
    this.root.add(this.spin)
  }

  setState(state: OrbState) {
    this.target = ORB_PARAMS[state]
    this.working = state === 'thinking' || state === 'using_tool'
  }

  /** Jump straight to a state without easing. */
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
    // reduced motion: no shape changes, the orb stays a sphere
    const shape = this.ring.update(dt, !opts.reducedMotion && this.working)
    // the ring always carries the thinking energy (turbulence, faster flow, violet)
    const p = shape.energy > 0 ? mixParams(this.current, ORB_PARAMS.thinking, shape.energy) : this.current
    const m = opts.motion
    this.time += dt * (0.25 + p.speed * 1.3) * m
    this.flowTime += dt * p.flow * m
    this.impulse *= Math.exp(-dt * 3.5)
    if (this.wave >= 0) {
      this.wave += dt / 0.95
      // violet afterglow on the rim once the cyan wave has left the centre
      if (this.wave > 0.35) this.afterglow = Math.max(this.afterglow, Math.min(1, (this.wave - 0.35) * 3))
      if (this.wave > 1) this.wave = -1
    } else {
      this.afterglow *= Math.exp(-dt * 1.4)
    }
    // the ring spins horizontally (around its own axis) and leans towards the viewer
    this.spin.rotation.y += dt * (0.03 + p.speed * 0.06) * m + dt * 1.1 * shape.spin * m
    // oblique ring: leaning towards the viewer and tilted sideways
    this.spin.rotation.x = 0.3 + Math.sin(this.time * 0.1) * 0.05 + 0.15 * shape.morph
    this.root.rotation.z = -0.5 * shape.morph
    this.arcGroup.rotation.y += dt * (0.015 + p.orbit * 0.2) * m

    const u = this.u
    u.uTime.value = this.time
    u.uMorph.value = shape.morph
    u.uShrink.value = shape.shrink
    u.uScatter.value = shape.scatter
    u.uFlatten.value = shape.flatten
    this.glow.scale.setScalar((2 / 2.2) * shape.shrink)
    u.uFlowTime.value = this.flowTime
    u.uDeform.value = p.deform
    u.uCore.value = p.core
    u.uPurple.value = p.purple
    u.uPlasma.value = p.plasma
    u.uDischarge.value = p.discharge
    u.uAlternate.value = p.alternate
    u.uOrbit.value = p.orbit
    u.uCompress.value = p.compression
    u.uDisperse.value = p.dispersion
    u.uImpulse.value = opts.reducedMotion ? 0 : this.impulse
    u.uWave.value = this.wave
    u.uAfterglow.value = this.afterglow
    u.uJitter.value = p.jitter
    u.uWarm.value = p.warm
    u.uRhythm.value = opts.reducedMotion ? 0 : p.rhythm
    u.uFluxReach.value = p.fluxReach
    u.uPixelRatio.value = opts.pixelRatio
    u.uBrightness.value = p.brightness * (0.35 + 0.65 * opts.presence) * (1 + 0.3 * shape.morph)
    u.uSaturation.value = p.saturation
    const outward = Math.max(0, this.impulse)
    this.glowUniforms.uGlow.value = p.glow * (1 + outward * 0.2)
    this.arcUniforms.uIntensity.value = p.flux * (1 + outward)
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
