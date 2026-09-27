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

export const FUTURE_ORB_STATES: readonly OrbState[] = ['listening', 'speaking', 'interrupted']

/** Targets the renderer eases towards; every value is a smooth scalar. */
export interface OrbParams {
  /** time multiplier for all motion */
  speed: number
  /** noise displacement of the shell */
  turbulence: number
  /** 1 = tight luminous shell; lower = particles drift off the surface */
  cohesion: number
  /** orbital swirl and arc visibility */
  orbit: number
  /** extra radius (response pulse) */
  pulse: number
  /** overall brightness multiplier */
  brightness: number
  /** 0 = electric blue; positive drifts slightly toward violet/magenta */
  hueShift: number
  /** 1 = full colour, 0 = grey */
  saturation: number
}

export const ORB_PARAMS: Record<OrbState, OrbParams> = {
  idle: { speed: 0.22, turbulence: 0.03, cohesion: 1, orbit: 0.18, pulse: 0, brightness: 0.9, hueShift: 0, saturation: 1 },
  thinking: { speed: 0.6, turbulence: 0.12, cohesion: 0.96, orbit: 0.35, pulse: 0.015, brightness: 1.05, hueShift: 0.05, saturation: 1 },
  using_tool: { speed: 0.75, turbulence: 0.1, cohesion: 0.92, orbit: 1, pulse: 0.01, brightness: 1.1, hueShift: 0.1, saturation: 1 },
  response: { speed: 0.5, turbulence: 0.07, cohesion: 1, orbit: 0.4, pulse: 0.09, brightness: 1.3, hueShift: 0.02, saturation: 1 },
  error: { speed: 0.3, turbulence: 0.2, cohesion: 0.74, orbit: 0.22, pulse: 0, brightness: 0.8, hueShift: 0.32, saturation: 0.85 },
  offline: { speed: 0.1, turbulence: 0.04, cohesion: 0.94, orbit: 0.05, pulse: -0.02, brightness: 0.45, hueShift: 0, saturation: 0.2 },
  // Reserved for Voice (not reachable in v0.4).
  listening: { speed: 0.35, turbulence: 0.08, cohesion: 1, orbit: 0.25, pulse: 0.03, brightness: 1.05, hueShift: -0.04, saturation: 1 },
  speaking: { speed: 0.55, turbulence: 0.09, cohesion: 1, orbit: 0.3, pulse: 0.05, brightness: 1.15, hueShift: 0, saturation: 1 },
  interrupted: { speed: 0.4, turbulence: 0.16, cohesion: 0.82, orbit: 0.2, pulse: 0, brightness: 0.85, hueShift: 0.4, saturation: 0.9 },
}

export interface OrbInputs {
  connection: ConnectionState
  runtime: RuntimeState
  /** true for a short moment after a `response` event */
  responding: boolean
}

/** Maps real runtime signals to exactly one orb state. */
export function deriveOrbState({ connection, runtime, responding }: OrbInputs): OrbState {
  if (connection !== 'open') return 'offline'
  if (runtime === 'error') return 'error'
  if (runtime === 'using_tool') return 'using_tool'
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
