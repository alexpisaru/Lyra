import * as THREE from 'three'
import { ORB_PARAMS, type OrbParams, type OrbState } from './orbState'
import {
  ARC_FRAGMENT,
  ARC_VERTEX,
  DUST_FRAGMENT,
  DUST_VERTEX,
  GLOW_FRAGMENT,
  GLOW_VERTEX,
  SHELL_FRAGMENT,
  SHELL_VERTEX,
} from './orbShaders'

export type QualityTier = 'high' | 'medium' | 'low'

export interface Quality {
  tier: QualityTier
  shell: number
  dust: number
  halo: number
  stars: number
  maxPixelRatio: number
}

export const QUALITY: Record<QualityTier, Quality> = {
  high: { tier: 'high', shell: 34000, dust: 2200, halo: 2600, stars: 700, maxPixelRatio: 2 },
  medium: { tier: 'medium', shell: 14000, dust: 1100, halo: 1300, stars: 380, maxPixelRatio: 2 },
  low: { tier: 'low', shell: 6000, dust: 500, halo: 600, stars: 200, maxPixelRatio: 1.5 },
}

export function pickQuality(env: {
  coarsePointer: boolean
  cores: number
  memory?: number
  minSide: number
}): Quality {
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

function sphereFibonacci(count: number, random: () => number) {
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = golden * i + random() * 0.4
    positions.set([Math.cos(theta) * radius, y, Math.sin(theta) * radius], i * 3)
    seeds.set([random(), random(), random()], i * 3)
  }
  return { positions, seeds }
}

function ball(count: number, inner: number, outer: number, power: number, random: () => number) {
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    const u = random() * 2 - 1
    const phi = random() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const r = inner + (outer - inner) * Math.pow(random(), power)
    positions.set([Math.cos(phi) * s * r, u * r, Math.sin(phi) * s * r], i * 3)
    seeds.set([random(), random(), random()], i * 3)
  }
  return { positions, seeds }
}

function points(data: { positions: Float32Array; seeds: Float32Array }) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(data.seeds, 3))
  return geometry
}

// Pure light: add colour, leave the canvas alpha at 0 so the CSS backdrop
// shows through (premultiplied compositing adds the glow on top of the page).
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
  random?: () => number
}

/**
 * Imperative Three.js scene. One instance lives for the whole app session;
 * React only calls setState/setFrame and dispose().
 */
export class OrbScene {
  readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50)
  private readonly orb = new THREE.Group() // framing: position + scale
  private readonly spin = new THREE.Group() // rotation only (the glow must not tilt)
  private readonly arcs = new THREE.Group()
  private readonly disposables: { dispose(): void }[] = []
  private readonly globalUniforms: Uniforms
  private readonly shellUniforms: Uniforms
  private readonly dustUniforms: Uniforms
  private readonly haloUniforms: Uniforms
  private readonly glowUniforms: Uniforms
  private readonly arcMaterials: THREE.ShaderMaterial[] = []
  private readonly starUniforms: Uniforms
  private readonly current: OrbParams = { ...ORB_PARAMS.idle }
  private target: OrbParams = ORB_PARAMS.idle
  private frame: OrbFrame = { size: 0.5, x: 0, y: 0.08, presence: 1 }
  private frameNow: OrbFrame = { size: 0.5, x: 0, y: 0.08, presence: 1 }
  private time = 0
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
    const random = options.random ?? Math.random
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
    })
    this.renderer.setClearColor(0x000000, 0)
    this.camera.position.set(0, 0, 6)

    const grade = { uBrightness: { value: 1 }, uHueShift: { value: 0 }, uSaturation: { value: 1 } }
    this.globalUniforms = grade
    const shared = { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uCohesion: { value: 1 } }

    // Glow billboard (rendered first, behind everything).
    this.glowUniforms = { ...grade, uOpacity: { value: 1 }, uRadius: { value: 1 } }
    const glowGeometry = new THREE.PlaneGeometry(4.4, 4.4)
    const glowMaterial = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      uniforms: this.glowUniforms,
      ...additive,
    })
    const glow = new THREE.Mesh(glowGeometry, glowMaterial)
    glow.renderOrder = 0
    // Scaled so the plane's uv radius 1 maps to 2.2 world units (see shader).
    glow.scale.setScalar(2 / 2.2)
    this.orb.add(glow)

    // Luminous shell.
    this.shellUniforms = {
      ...grade,
      ...shared,
      uTurb: { value: 0.05 },
      uPulse: { value: 0 },
      uOrbit: { value: 0.2 },
      uSize: { value: 26 },
    }
    const shellGeometry = points(sphereFibonacci(this.quality.shell, random))
    const shellMaterial = new THREE.ShaderMaterial({
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT,
      uniforms: this.shellUniforms,
      ...additive,
    })
    const shell = new THREE.Points(shellGeometry, shellMaterial)
    shell.renderOrder = 2
    this.spin.add(shell)

    // Inner dust.
    this.dustUniforms = {
      ...grade,
      ...shared,
      uSize: { value: 14 },
      uSpread: { value: 0.6 },
      uColor: { value: new THREE.Color(0.45, 0.78, 1.0) },
      uOpacity: { value: 0.55 },
    }
    const dustGeometry = points(ball(this.quality.dust, 0, 0.92, 0.6, random))
    const dustMaterial = new THREE.ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      uniforms: this.dustUniforms,
      ...additive,
    })
    const dust = new THREE.Points(dustGeometry, dustMaterial)
    dust.renderOrder = 1
    this.spin.add(dust)

    // Outer halo: scatters when cohesion drops.
    this.haloUniforms = {
      ...grade,
      ...shared,
      uSize: { value: 12 },
      uSpread: { value: 1.6 },
      uColor: { value: new THREE.Color(0.32, 0.55, 1.0) },
      uOpacity: { value: 0.3 },
    }
    const haloGeometry = points(ball(this.quality.halo, 1.04, 1.9, 2.4, random))
    const haloMaterial = new THREE.ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      uniforms: this.haloUniforms,
      ...additive,
    })
    const halo = new THREE.Points(haloGeometry, haloMaterial)
    halo.renderOrder = 3
    this.spin.add(halo)

    // Orbit arcs.
    const arcColors = [
      new THREE.Color(0.3, 0.6, 1.0),
      new THREE.Color(0.52, 0.34, 1.0),
      new THREE.Color(0.25, 0.8, 1.0),
      new THREE.Color(0.42, 0.45, 1.0),
      new THREE.Color(0.3, 0.7, 1.0),
      new THREE.Color(0.6, 0.38, 1.0),
      new THREE.Color(0.28, 0.66, 1.0),
      new THREE.Color(0.36, 0.52, 1.0),
    ]
    for (let k = 0; k < arcColors.length; k += 1) {
      const segments = 220
      // Half hug the surface as wisps, half swing wider as orbits.
      const near = k % 2 === 0
      const rx = near ? 1.02 + random() * 0.14 : 1.12 + random() * 0.45
      const ry = near ? 0.96 + random() * 0.12 : 0.5 + random() * 0.75
      const span = Math.PI * (0.7 + random() * 0.9)
      const start = random() * Math.PI * 2
      const positions = new Float32Array(segments * 3)
      const ts = new Float32Array(segments)
      for (let i = 0; i < segments; i += 1) {
        const t = i / (segments - 1)
        const a = start + span * t
        positions.set([Math.cos(a) * rx, Math.sin(a) * ry, Math.sin(a * 2) * 0.05], i * 3)
        ts[i] = t
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('aT', new THREE.BufferAttribute(ts, 1))
      const material = new THREE.ShaderMaterial({
        vertexShader: ARC_VERTEX,
        fragmentShader: ARC_FRAGMENT,
        uniforms: { ...grade, uColor: { value: arcColors[k] }, uOpacity: { value: 0.2 }, uPhase: { value: random() } },
        ...additive,
      })
      this.arcMaterials.push(material)
      const line = new THREE.Line(geometry, material)
      line.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI)
      line.userData.spin = (0.05 + random() * 0.12) * (random() > 0.5 ? 1 : -1)
      line.renderOrder = 4
      this.arcs.add(line)
      this.disposables.push(geometry, material)
    }
    this.spin.add(this.arcs)
    this.orb.add(this.spin)
    this.scene.add(this.orb)

    // Faint distant stars, independent from the orb framing.
    this.starUniforms = {
      ...grade,
      ...shared,
      uCohesion: { value: 1 },
      uSize: { value: 9 },
      uSpread: { value: 0 },
      uColor: { value: new THREE.Color(0.45, 0.6, 1.0) },
      uOpacity: { value: 0.35 },
    }
    const starData = ball(this.quality.stars, 0, 1, 1, random)
    for (let i = 0; i < starData.positions.length; i += 3) {
      starData.positions[i] *= 9
      starData.positions[i + 1] *= 5
      starData.positions[i + 2] = -4 - Math.abs(starData.positions[i + 2]) * 4
    }
    const starGeometry = points(starData)
    const starMaterial = new THREE.ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      uniforms: this.starUniforms,
      ...additive,
    })
    const stars = new THREE.Points(starGeometry, starMaterial)
    stars.renderOrder = -1
    this.scene.add(stars)

    this.disposables.push(
      glowGeometry,
      glowMaterial,
      shellGeometry,
      shellMaterial,
      dustGeometry,
      dustMaterial,
      haloGeometry,
      haloMaterial,
      starGeometry,
      starMaterial,
    )
  }

  setState(state: OrbState) {
    this.target = ORB_PARAMS[state]
  }

  /** New framing target; with `snap` it jumps there without easing (first frame). */
  setFrame(frame: OrbFrame, snap = false) {
    this.frame = frame
    if (snap) this.frameNow = { ...frame }
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

    const ease = 1 - Math.exp(-dt * 2.6)
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
    this.time += dt * (0.35 + p.speed * 1.6) * motion

    // Framing: a unit sphere spans `size` of the shorter viewport side.
    const visibleH = 2 * this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const visibleW = visibleH * this.camera.aspect
    const minVisible = Math.min(visibleH, visibleW)
    this.orb.scale.setScalar((f.size * minVisible) / 2)
    this.orb.position.set((f.x * visibleW) / 2, (f.y * visibleH) / 2, 0)
    this.spin.rotation.y += dt * (0.04 + p.speed * 0.1) * motion
    this.spin.rotation.x = 0.35 + Math.sin(this.time * 0.1) * 0.04

    const breath = this.reducedMotion ? 0 : Math.sin(this.time * 0.9) * 0.012
    const presence = f.presence
    this.globalUniforms.uBrightness.value = p.brightness * (0.35 + 0.65 * presence)
    this.globalUniforms.uHueShift.value = p.hueShift
    this.globalUniforms.uSaturation.value = p.saturation
    for (const u of [this.shellUniforms, this.dustUniforms, this.haloUniforms, this.starUniforms]) {
      u.uTime.value = this.time
      u.uPixelRatio.value = this.pixelRatio
    }
    // Point sizes follow the on-screen orb size so a small orb stays crisp.
    const sizeScale = Math.max(0.35, (f.size * Math.min(this.width, this.height)) / 520)
    this.shellUniforms.uSize.value = 10.5 * sizeScale
    this.dustUniforms.uSize.value = 9 * sizeScale
    this.haloUniforms.uSize.value = 8 * sizeScale
    this.shellUniforms.uTurb.value = p.turbulence
    this.shellUniforms.uCohesion.value = p.cohesion
    this.dustUniforms.uCohesion.value = p.cohesion
    this.haloUniforms.uCohesion.value = p.cohesion
    this.shellUniforms.uPulse.value = p.pulse + breath
    this.shellUniforms.uOrbit.value = p.orbit
    this.haloUniforms.uOpacity.value = (0.22 + (1 - p.cohesion) * 1.4 + p.orbit * 0.12) * presence
    this.glowUniforms.uOpacity.value = 0.75 + p.pulse * 3
    this.glowUniforms.uRadius.value = 1 + p.pulse
    this.starUniforms.uOpacity.value = 0.32 * (0.6 + 0.4 * presence)

    this.arcs.children.forEach((line, index) => {
      line.rotation.z += dt * (line.userData.spin as number) * (0.4 + p.orbit * 2.2) * motion
      const material = this.arcMaterials[index]
      material.uniforms.uOpacity.value = (0.3 + p.orbit * 0.6) * presence
      material.uniforms.uPhase.value = (material.uniforms.uPhase.value + dt * (0.05 + p.orbit * 0.35) * motion) % 1
    })

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
