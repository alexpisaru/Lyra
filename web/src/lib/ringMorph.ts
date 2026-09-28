/**
 * The "working" shape of the orb: while Lyra thinks or uses a tool the sphere
 * breaks apart, re-gathers into an uneven oblique ring that keeps spinning, and
 * when the work ends it breaks apart again and closes back into the sphere.
 * Pure timing (no three.js), so it can be tested; the shaders read the values.
 */

export interface RingShape {
  /** 0 = sphere, 1 = ring */
  morph: number
  /** overall scale (short shrink before breaking apart) */
  shrink: number
  /** chunks drifting apart (decomposition) */
  scatter: number
  /** squeeze into a flat oblique ellipse */
  flatten: number
  /** extra spin speed of the ring */
  spin: number
  /** how much of the thinking energy to borrow (turbulence, flow, violet) */
  energy: number
}

export const SPHERE: RingShape = { morph: 0, shrink: 1, scatter: 0, flatten: 0, spin: 0, energy: 0 }

const ease = (x: number) => x * x * (3 - 2 * x)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const seg = (t: number, a: number, b: number) => ease(clamp01((t - a) / (b - a)))

/** Seconds from the start of the work to a fully formed ring. */
export const ENTER_SECONDS = 3.2
/** Seconds from the end of the work back to the sphere. */
export const EXIT_SECONDS = 2.4

/** Entering and then holding the ring for as long as the work lasts. */
export function enterShape(t: number): RingShape {
  const shrink = 1 - 0.3 * seg(t, 0, 0.6) + 0.3 * seg(t, 0.6, 1.8)
  // decomposition, then it settles to a small residual that keeps breathing
  const hold = t > ENTER_SECONDS ? 0.12 + 0.08 * Math.sin((t - ENTER_SECONDS) * 0.9) : 0
  const scatter = Math.max(0, 0.6 * seg(t, 0.5, 1.4) - 0.42 * seg(t, 1.8, 3.2)) + hold * seg(t, 3.0, 3.6)
  const morph = seg(t, 1.2, ENTER_SECONDS)
  // every ~9 s the ring squeezes into a flat ellipse and opens up again
  const cycle = t > 5 ? Math.sin(((t - 5) / 9) * Math.PI) ** 2 : 0
  const flatten = 0.8 * cycle * morph
  const spin = morph * (0.9 + 0.35 * Math.sin(t * 0.45))
  return { morph, shrink, scatter, flatten, spin, energy: seg(t, 0, 0.8) }
}

/** Leaving from wherever the ring was (`from`) back to the sphere. */
export function exitShape(from: RingShape, t: number): RingShape {
  const out = seg(t, 0, EXIT_SECONDS)
  return {
    morph: from.morph * (1 - seg(t, 0.2, EXIT_SECONDS)),
    shrink: 1 + (from.shrink - 1) * (1 - out) - 0.15 * Math.sin(Math.PI * clamp01(t / EXIT_SECONDS)),
    scatter: (from.scatter + 0.3 * seg(t, 0, 0.5)) * (1 - seg(t, 0.8, EXIT_SECONDS)),
    flatten: from.flatten * (1 - seg(t, 0, 0.9)),
    spin: from.spin * (1 - out),
    energy: from.energy * (1 - seg(t, EXIT_SECONDS - 0.8, EXIT_SECONDS)),
  }
}

/**
 * Drives the shape from a boolean "working" signal. Entering while still
 * leaving resumes from the current ring instead of restarting.
 */
export class RingMorph {
  private enterT = -1
  private exitT = -1
  private exitFrom: RingShape = SPHERE
  private last: RingShape = SPHERE

  update(dt: number, working: boolean): RingShape {
    if (working) {
      if (this.enterT < 0) {
        // resume: skip the intro in proportion to how much ring is still there
        this.enterT = this.exitT >= 0 && this.last.morph > 0.3 ? ENTER_SECONDS * this.last.morph : 0
        this.exitT = -1
      } else {
        this.enterT += dt
      }
      this.last = enterShape(this.enterT)
    } else if (this.enterT >= 0 || this.exitT >= 0) {
      if (this.enterT >= 0) {
        this.exitFrom = this.last
        this.exitT = 0
        this.enterT = -1
      } else {
        this.exitT += dt
      }
      this.last = exitShape(this.exitFrom, this.exitT)
      if (this.exitT > EXIT_SECONDS) {
        this.exitT = -1
        this.last = SPHERE
      }
    }
    return this.last
  }
}
