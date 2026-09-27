import type { LyraEvent } from '../types/api'
import type { ConnectionState } from './websocket'

export type ActivityKind = 'thinking' | 'tool' | 'tool_done' | 'response' | 'error' | 'connection'

export interface ActivityEntry {
  id: number
  at: number
  kind: ActivityKind
  title: string
  detail?: string
  success?: boolean
}

export interface ActivityState {
  entries: ActivityEntry[]
  nextId: number
  wasOpen: boolean
}

export type ActivityAction =
  | { type: 'event'; event: LyraEvent; at: number }
  | { type: 'connection'; state: ConnectionState; at: number }
  | { type: 'clear' }

export const MAX_ENTRIES = 200
export const initialActivity: ActivityState = { entries: [], nextId: 1, wasOpen: false }

function oneLine(text: string, limit: number) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function push(state: ActivityState, entry: Omit<ActivityEntry, 'id'>): ActivityState {
  const entries = [...state.entries, { ...entry, id: state.nextId }]
  return {
    ...state,
    entries: entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries,
    nextId: state.nextId + 1,
  }
}

/**
 * Turns raw /ws events into a quiet timeline: state changes, tool name,
 * success/failure, response and errors. No payloads, no JSON.
 */
export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  if (action.type === 'clear') return { ...state, entries: [] }

  if (action.type === 'connection') {
    if (action.state === 'open') {
      const next = push(state, { at: action.at, kind: 'connection', title: 'Connessa', detail: 'Eventi in tempo reale attivi', success: true })
      return { ...next, wasOpen: true }
    }
    if (action.state === 'closed' && state.wasOpen) {
      const next = push(state, { at: action.at, kind: 'connection', title: 'Disconnessa', detail: 'Nuovo tentativo in corso', success: false })
      return { ...next, wasOpen: false }
    }
    return state
  }

  const { event, at } = action
  const last = state.entries[state.entries.length - 1]
  switch (event.type) {
    case 'state':
      // using_tool is described by tool_started; idle/error need no row of their own.
      if (event.state !== 'thinking' || last?.kind === 'thinking') return state
      return push(state, { at, kind: 'thinking', title: 'Thinking', detail: 'Elaborazione della richiesta' })
    case 'tool_started':
      return push(state, { at, kind: 'tool', title: 'Using tool', detail: event.tool })
    case 'tool_finished':
      return push(state, {
        at,
        kind: 'tool_done',
        title: event.success ? 'Tool completed' : 'Tool failed',
        detail: event.tool,
        success: event.success,
      })
    case 'response':
      return push(state, { at, kind: 'response', title: 'Response', detail: oneLine(event.content, 140) })
    case 'error':
      return push(state, { at, kind: 'error', title: 'Errore', detail: oneLine(event.message, 160), success: false })
    default:
      return state
  }
}

export function formatClock(at: number) {
  return new Date(at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
