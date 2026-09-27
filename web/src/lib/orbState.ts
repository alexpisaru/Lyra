import type { RuntimeState } from '../types/api'
import type { ConnectionState } from './websocket'

/**
 * Visual states of the orb. The first six are produced today from real /ws
 * events. listening / speaking / interrupted are reserved for Voice: the
 * renderer knows how to draw them, but nothing in v0.4 ever enters them.
 */
export type OrbState =
  | 'idle'
  | 'thinking'
  | 'using_tool'
  | 'response'
  | 'error'
  | 'offline'
  | 'listening'
  | 'speaking'
  | 'interrupted'

export const LIVE_ORB_STATES: readonly OrbState[] = ['idle', 'thinking', 'using_tool', 'response', 'error', 'offline']
export const FUTURE_ORB_STATES: readonly OrbState[] = ['listening', 'speaking', 'interrupted']

/** One-shot visual events on top of the state (real /ws tool_started, tool_finished, response). */
export type OrbPulse = 'tool_started' | 'tool_finished' | 'response'

/** Targets the renderer eases towards (~450 ms); every value is a smooth scalar. */
export interface OrbParams {
  /** global time multiplier */
  speed: number
  /** silhouette deformation (noise bulges) */
  deform: number
  /** speed of light travelling along the filaments */
  flow: number
  /** core pulse amplitude */
  core: number
  /** violet / indigo energy layer intensity */
  purple: number
  /** cyan <-> violet alternation of highlights (thinking) */
  alternate: number
  /** visibility of external arcs leaving the sphere */
  arcs: number
  /** orbital organisation (swirl + arc rotation) */
  orbit: number
  /** inner volume pulled towards the centre */
  compression: number
  /** particles drifting away from the surface */
  dispersion: number
  /** halo / bloom strength */
  glow: number
  /** overall brightness */
  brightness: number
  /** 0 = violet stays violet; 1 = violet drifts to magenta/red-violet */
  hueShift: number
  /** 1 = full colour, 0 = grey */
  saturation: number
  /** high-frequency instability */
  jitter: number
}

export const ORB_PARAMS: Record<OrbState, OrbParams> = {
  idle: {
    speed: 0.35, deform: 0.05, flow: 0.25, core: 0.14, purple: 0.6, alternate: 0, arcs: 0.3, orbit: 0.15,
    compression: 0, dispersion: 0.05, glow: 0.95, brightness: 1.08, hueShift: 0, saturation: 1, jitter: 0,
  },
  thinking: {
    speed: 1.05, deform: 0.1, flow: 1.25, core: 0.85, purple: 1.05, alternate: 1, arcs: 0.38, orbit: 0.28,
    compression: 0, dispersion: 0.1, glow: 1.12, brightness: 1.12, hueShift: 0, saturation: 1, jitter: 0,
  },
  using_tool: {
    speed: 0.8, deform: 0.06, flow: 0.75, core: 0.3, purple: 0.8, alternate: 0.2, arcs: 1.1, orbit: 1,
    compression: 0.28, dispersion: 0.28, glow: 1.08, brightness: 1.08, hueShift: 0, saturation: 1, jitter: 0,
  },
  response: {
    speed: 0.6, deform: 0.05, flow: 0.55, core: 0.45, purple: 0.95, alternate: 0, arcs: 0.55, orbit: 0.35,
    compression: 0, dispersion: 0.18, glow: 1.3, brightness: 1.22, hueShift: 0, saturation: 1, jitter: 0,
  },
  error: {
    speed: 0.5, deform: 0.14, flow: 0.35, core: 0.2, purple: 0.75, alternate: 0, arcs: 0.3, orbit: 0.2,
    compression: 0, dispersion: 0.55, glow: 0.7, brightness: 0.86, hueShift: 0.8, saturation: 0.9, jitter: 1,
  },
  offline: {
    speed: 0.06, deform: 0.02, flow: 0.05, core: 0, purple: 0.06, alternate: 0, arcs: 0.04, orbit: 0.05,
    compression: 0, dispersion: 0.02, glow: 0.3, brightness: 0.45, hueShift: 0, saturation: 0.15, jitter: 0,
  },
  // Reserved for Voice (not reachable in v0.4).
  listening: {
    speed: 0.45, deform: 0.06, flow: 0.4, core: 0.3, purple: 0.5, alternate: 0, arcs: 0.25, orbit: 0.2,
    compression: 0.1, dispersion: 0.05, glow: 1, brightness: 1.05, hueShift: 0, saturation: 1, jitter: 0,
  },
  speaking: {
    speed: 0.7, deform: 0.07, flow: 0.8, core: 0.6, purple: 0.8, alternate: 0.3, arcs: 0.4, orbit: 0.3,
    compression: 0, dispersion: 0.1, glow: 1.15, brightness: 1.15, hueShift: 0, saturation: 1, jitter: 0,
  },
  interrupted: {
    speed: 0.5, deform: 0.12, flow: 0.3, core: 0.1, purple: 0.6, alternate: 0, arcs: 0.2, orbit: 0.2,
    compression: 0, dispersion: 0.35, glow: 0.8, brightness: 0.9, hueShift: 0.5, saturation: 0.9, jitter: 0.5,
  },
}

export interface OrbInputs {
  connection: ConnectionState
  runtime: RuntimeState
  /** true for a short moment after a `response` event */
  responding: boolean
  /** true from tool_started until shortly after tool_finished (fast tools stay visible) */
  toolHold?: boolean
}

/** Maps real runtime signals to exactly one orb state. */
export function deriveOrbState({ connection, runtime, responding, toolHold = false }: OrbInputs): OrbState {
  if (connection !== 'open') return 'offline'
  if (runtime === 'error') return 'error'
  if (runtime === 'using_tool' || (toolHold && runtime !== 'idle')) return 'using_tool'
  if (runtime === 'thinking') return 'thinking'
  if (responding) return 'response'
  return 'idle'
}

export function orbParams(state: OrbState): OrbParams {
  return ORB_PARAMS[state]
}

export const ORB_LABEL: Record<OrbState, string> = {
  idle: 'In attesa',
  thinking: 'Elabora',
  using_tool: 'Usa uno strumento',
  response: 'Risponde',
  error: 'Errore',
  offline: 'Non raggiungibile',
  listening: 'Ascolta',
  speaking: 'Parla',
  interrupted: 'Interrotto',
}
