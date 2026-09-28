import type { RuntimeState } from '../types/api'
import type { ConnectionState } from './websocket'

/**
 * Visual states of the orb. idle/thinking/using_tool/response/error/offline are
 * produced by real /ws events. listening / speaking / interrupted belong to the
 * future Voice layer: the renderer can draw them but the live orb never enters
 * them in v0.4.
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
  /** speed of energy along the flux loops and of bloom migration */
  flow: number
  /** core pulse amplitude */
  core: number
  /** violet / magenta zones on the rim (and their glow) */
  purple: number
  /** faint luminous clouds over the sphere surface */
  plasma: number
  /** the energy web over the sphere (brightness and crackle) */
  discharge: number
  /** cyan <-> violet alternation of highlights (thinking) */
  alternate: number
  /** visibility of the thin outer arcs */
  flux: number
  /** how far the outer arcs swing out of the sphere (1 = at rest) */
  fluxReach: number
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
}

const base: OrbParams = {
  speed: 0.3, deform: 0.04, flow: 0.25, core: 0.15, purple: 1.3, plasma: 0.35, discharge: 0.85, alternate: 0, flux: 0.85,
  fluxReach: 1, orbit: 0.15, compression: 0, dispersion: 0.05, glow: 1, brightness: 1.38, warm: 0,
  saturation: 1, jitter: 0, rhythm: 0,
}

export const ORB_PARAMS: Record<OrbState, OrbParams> = {
  idle: base,
  thinking: {
    ...base, speed: 0.95, deform: 0.08, flow: 1.1, core: 0.6, purple: 1.55, plasma: 0.5, discharge: 1.35, alternate: 1,
    flux: 1.0, fluxReach: 0.94, orbit: 0.45, compression: 0.05, dispersion: 0.08, glow: 1.1, brightness: 1.12,
  },
  using_tool: {
    ...base, speed: 0.75, deform: 0.06, flow: 0.75, core: 0.3, purple: 0.9, plasma: 0.4, discharge: 1.05, alternate: 0.2,
    flux: 1.15, fluxReach: 1.18, orbit: 1, compression: 0.25, dispersion: 0.55, glow: 1.12, brightness: 1.1,
  },
  response: {
    ...base, speed: 0.55, deform: 0.05, flow: 0.55, core: 0.25, purple: 1.05, plasma: 0.45, discharge: 1.15, flux: 0.8,
    fluxReach: 1.15, orbit: 0.35, dispersion: 0.3, glow: 1.25, brightness: 1.08,
  },
  error: {
    ...base, speed: 0.45, deform: 0.12, flow: 0.3, core: 0.2, purple: 0.85, plasma: 0.25, discharge: 0.5, flux: 0.35,
    fluxReach: 1.05, orbit: 0.2, dispersion: 0.5, glow: 0.75, brightness: 0.88, warm: 0.4, saturation: 0.9,
    jitter: 1,
  },
  offline: {
    ...base, speed: 0.06, deform: 0.02, flow: 0.05, core: 0, purple: 0.08, plasma: 0.15, discharge: 0.2, flux: 0.08,
    orbit: 0.05, dispersion: 0.02, glow: 0.3, brightness: 0.45, saturation: 0.15,
  },
  // Voice states: drawn in previews, never entered by the live orb in v0.4.
  listening: { ...base, speed: 0.4, flow: 0.35, core: 0.3, purple: 0.65, compression: 0.1, glow: 1.05, rhythm: 0.3 },
  speaking: {
    ...base, speed: 1.0, deform: 0.12, flow: 1.2, core: 0.5, purple: 1.4, plasma: 0.45, discharge: 1.3, alternate: 0.8,
    flux: 0.8, fluxReach: 1.1, orbit: 0.45, dispersion: 0.2, glow: 1.15, brightness: 1.15, rhythm: 1.2,
  },
  interrupted: {
    ...base, speed: 0.5, deform: 0.12, flow: 0.3, core: 0.15, purple: 0.95, plasma: 0.3, discharge: 0.9, flux: 0.45,
    fluxReach: 1.2, orbit: 0.25, dispersion: 0.5, glow: 1, brightness: 1, warm: 0.9, jitter: 0.7,
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

// Lyra's real tool ids (src/openjarvis/tools) -> plain Italian
const TOOL_NAME: Record<string, string> = {
  calculator: 'la calcolatrice',
  notes_search: 'le note',
  notes_read: 'le note',
  memory_retrieve: 'la memoria',
  memory_store: 'la memoria',
  file_read: 'i file',
}

/** What Lyra is doing, in plain words, for the line under the orb (null = say nothing). */
export function workCaption(state: OrbState, tool: string | null): string | null {
  if (state === 'thinking') return 'Sto pensando…'
  if (state === 'using_tool') {
    if (!tool) return 'Uso uno strumento…'
    const known = TOOL_NAME[tool] ?? (tool.startsWith('browser') ? 'il browser' : tool.startsWith('memory') ? 'la memoria' : null)
    return known ? `Uso ${known}…` : `Uso ${tool.replace(/_/g, ' ')}…`
  }
  if (state === 'error') return 'Qualcosa non è andato'
  return null
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

/**
 * Orb state once Lyra Voice is wired to it (later phases; not used in phase 1,
 * where the orb follows the runtime only). Real work (thinking / tools / answer /
 * errors / offline) always wins; the voice only colours an otherwise idle orb.
 */
export function orbStateWithVoice(
  runtime: OrbState,
  voice: 'off' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error',
): OrbState {
  if (runtime !== 'idle') return runtime
  if (voice === 'listening' || voice === 'speaking' || voice === 'interrupted') return voice
  if (voice === 'thinking') return 'thinking'
  return runtime
}
