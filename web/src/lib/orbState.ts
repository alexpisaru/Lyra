import type { RuntimeState } from '../types/api'
import type { ConnectionState } from './websocket'

/**
 * Visual states of the orb. idle/thinking/using_tool/response/error/offline are
 * produced by real /ws events. listening / speaking / interrupted belong to the
 * future Voice layer: the renderer draws them (the "Stati principali" previews
 * show speaking and interrupted) but the live orb never enters them in v0.4.
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

/** The six states shown in the "Stati principali" column, as in the reference. */
export const SHOWCASE_STATES: readonly { state: OrbState; title: string; subtitle: string }[] = [
  { state: 'idle', title: 'Idle', subtitle: 'in attesa' },
  { state: 'thinking', title: 'Thinking', subtitle: 'elabora' },
  { state: 'using_tool', title: 'Using tool', subtitle: 'usa uno strumento' },
  { state: 'response', title: 'Response', subtitle: 'risponde' },
  { state: 'speaking', title: 'Speaking', subtitle: 'parla' },
  { state: 'interrupted', title: 'Interrupted', subtitle: 'interrotto' },
]

/** One-shot visual events on top of the state (real /ws tool_started, tool_finished, response). */
export type OrbPulse = 'tool_started' | 'tool_finished' | 'response'

/** Targets the renderer eases towards (~450 ms); every value is a smooth scalar. */
export interface OrbParams {
  /** global time multiplier */
  speed: number
  /** silhouette deformation (noise bulges) */
  deform: number
  /** speed of energy travelling through veins and streaks */
  flow: number
  /** core pulse amplitude */
  core: number
  /** violet / indigo energy layer intensity */
  purple: number
  /** luminous vein network on the shell */
  veins: number
  /** cyan <-> violet alternation of highlights (thinking) */
  alternate: number
  /** visibility of the external arcs */
  arcs: number
  /** how far the arcs swing out of the sphere */
  arcSpread: number
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
  /** 0 = cyan/violet; 1 = shifted to rose / magenta (interrupted, error) */
  warm: number
  /** 1 = full colour, 0 = grey */
  saturation: number
  /** high-frequency instability */
  jitter: number
  /** rhythmic organic pulsation (speaking) */
  rhythm: number
  /** radial starburst from the centre (response) */
  flare: number
}

const base: OrbParams = {
  speed: 0.3, deform: 0.04, flow: 0.25, core: 0.15, purple: 0.75, veins: 0.9, alternate: 0, arcs: 0.55,
  arcSpread: 1, orbit: 0.15, compression: 0, dispersion: 0.05, glow: 1.1, brightness: 1.2, warm: 0,
  saturation: 1, jitter: 0, rhythm: 0, flare: 0,
}

export const ORB_PARAMS: Record<OrbState, OrbParams> = {
  idle: base,
  thinking: {
    ...base, speed: 0.95, deform: 0.08, flow: 1.1, core: 0.85, purple: 1.15, veins: 1.2, alternate: 1,
    arcs: 0.8, arcSpread: 0.94, orbit: 0.45, compression: 0.05, dispersion: 0.08, glow: 1.1, brightness: 1.12,
  },
  using_tool: {
    ...base, speed: 0.75, deform: 0.06, flow: 0.75, core: 0.3, purple: 0.9, veins: 1.05, alternate: 0.2,
    arcs: 1.6, arcSpread: 1.45, orbit: 1, compression: 0.25, dispersion: 0.55, glow: 1.12, brightness: 1.1,
  },
  response: {
    ...base, speed: 0.55, deform: 0.05, flow: 0.55, core: 0.55, purple: 1.05, veins: 1.25, arcs: 0.8,
    arcSpread: 1.15, orbit: 0.35, dispersion: 0.22, glow: 1.4, brightness: 1.25, flare: 1,
  },
  error: {
    ...base, speed: 0.45, deform: 0.12, flow: 0.3, core: 0.2, purple: 0.85, veins: 0.6, arcs: 0.35,
    arcSpread: 1.05, orbit: 0.2, dispersion: 0.5, glow: 0.75, brightness: 0.88, warm: 0.4, saturation: 0.9,
    jitter: 1,
  },
  offline: {
    ...base, speed: 0.06, deform: 0.02, flow: 0.05, core: 0, purple: 0.08, veins: 0.35, arcs: 0.08,
    orbit: 0.05, dispersion: 0.02, glow: 0.3, brightness: 0.45, saturation: 0.15,
  },
  // Voice states: drawn in previews, never entered by the live orb in v0.4.
  listening: { ...base, speed: 0.4, flow: 0.35, core: 0.3, purple: 0.65, compression: 0.1, glow: 1.05, rhythm: 0.3 },
  speaking: {
    ...base, speed: 0.6, deform: 0.06, flow: 0.6, core: 0.55, purple: 0.9, veins: 1.05, alternate: 0.3,
    arcs: 0.65, arcSpread: 1.1, orbit: 0.3, dispersion: 0.1, glow: 1.15, brightness: 1.15, rhythm: 1,
  },
  interrupted: {
    ...base, speed: 0.5, deform: 0.12, flow: 0.3, core: 0.15, purple: 0.95, veins: 0.7, arcs: 0.45,
    arcSpread: 1.2, orbit: 0.25, dispersion: 0.5, glow: 1, brightness: 1, warm: 0.9, jitter: 0.7,
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
