import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api } from '../lib/api'
import { activityReducer, initialActivity } from '../lib/activity'
import { deriveOrbState, type OrbPulse } from '../lib/orbState'
import { LyraSocket, type ConnectionState } from '../lib/websocket'
import type { LyraEvent, LyraStatus, RuntimeState } from '../types/api'
import { useLyraWebSocket } from './useLyraWebSocket'

export const STATUS_POLL_MS = 30000
export const RESPONSE_PULSE_MS = 1400
/** A fast tool (calculator) lasts ~50 ms: keep its visual state long enough to be seen. */
export const TOOL_HOLD_MS = 1200
/** Minimum gap between the outward (tool_started) and inward (tool_finished) pulses. */
export const TOOL_PULSE_GAP_MS = 450

export interface OrbSignal {
  kind: OrbPulse
  at: number
}

export interface LyraStateOptions {
  socket?: LyraSocket
  pollMs?: number
}

/**
 * Single source of truth for everything live: /api/status, the /ws connection,
 * the runtime state reported by Lyra Core and the Activity timeline.
 */
export function useLyraState({ socket: injected, pollMs = STATUS_POLL_MS }: LyraStateOptions = {}) {
  const [socket] = useState(() => injected ?? new LyraSocket())
  const [status, setStatus] = useState<LyraStatus | null>(null)
  const [reachable, setReachable] = useState<boolean | null>(null)
  const [runtime, setRuntime] = useState<RuntimeState>('idle')
  const [responding, setResponding] = useState(false)
  const [toolHold, setToolHold] = useState(false)
  // name of the tool Lyra is using (from /ws tool_started), for the caption under the orb
  const [tool, setTool] = useState<string | null>(null)
  const toolTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolStartedAt = useRef(0)
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [activity, dispatch] = useReducer(activityReducer, initialActivity)
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // One-shot orb events straight from the real runtime (tool start/finish, response).
  const [signal, setSignal] = useState<OrbSignal | null>(null)

  // State is only set in promise callbacks (never synchronously inside an effect).
  const refreshStatus = useCallback(
    () =>
      api.status().then(
        (next) => {
          setStatus(next)
          setReachable(true)
          return next
        },
        () => {
          setReachable(false)
          return null
        },
      ),
    [],
  )

  const onEvent = useCallback((event: LyraEvent) => {
    dispatch({ type: 'event', event, at: Date.now() })
    if (event.type === 'state') {
      setRuntime(event.state)
      if (event.state === 'idle') setTool(null)
    }
    if (event.type === 'tool_started') setTool(event.tool)
    if (event.type === 'response') setTool(null)
    if (event.type === 'tool_started' || event.type === 'response') {
      setSignal({ kind: event.type, at: performance.now() })
    }
    if (event.type === 'tool_started') toolStartedAt.current = performance.now()
    if (event.type === 'tool_finished') {
      // Fast tools finish ~30 ms after starting: space the in-pulse after the out-pulse.
      const wait = Math.max(0, TOOL_PULSE_GAP_MS - (performance.now() - toolStartedAt.current))
      if (finishTimer.current) clearTimeout(finishTimer.current)
      finishTimer.current = setTimeout(() => setSignal({ kind: 'tool_finished', at: performance.now() }), wait)
    }
    if (event.type === 'tool_started') {
      if (toolTimer.current) clearTimeout(toolTimer.current)
      setToolHold(true)
    }
    if (event.type === 'tool_finished') {
      if (toolTimer.current) clearTimeout(toolTimer.current)
      toolTimer.current = setTimeout(() => setToolHold(false), TOOL_HOLD_MS)
    }
    if (event.type === 'response') {
      setResponding(true)
      if (pulseTimer.current) clearTimeout(pulseTimer.current)
      pulseTimer.current = setTimeout(() => setResponding(false), RESPONSE_PULSE_MS)
    }
  }, [])

  const onConnection = useCallback(
    (state: ConnectionState) => {
      dispatch({ type: 'connection', state, at: Date.now() })
      if (state === 'open') void refreshStatus()
      if (state === 'closed') {
        setRuntime('idle')
        setToolHold(false)
        setTool(null)
      }
    },
    [refreshStatus],
  )

  const connection = useLyraWebSocket(socket, onEvent, onConnection)

  useEffect(() => {
    void refreshStatus()
    const timer = setInterval(() => void refreshStatus(), pollMs)
    return () => clearInterval(timer)
  }, [refreshStatus, pollMs])

  useEffect(
    () => () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current)
      if (toolTimer.current) clearTimeout(toolTimer.current)
      if (finishTimer.current) clearTimeout(finishTimer.current)
    },
    [],
  )

  const orbState = useMemo(
    () => deriveOrbState({ connection, runtime, responding, toolHold }),
    [connection, runtime, responding, toolHold],
  )

  const online = reachable === true && connection === 'open'
  const clearActivity = useCallback(() => dispatch({ type: 'clear' }), [])

  return {
    status,
    reachable,
    online,
    connection,
    runtime,
    orbState,
    tool,
    signal,
    activity: activity.entries,
    clearActivity,
    refreshStatus,
  }
}

export type LyraLive = ReturnType<typeof useLyraState>
