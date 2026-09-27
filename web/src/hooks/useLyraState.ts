import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api } from '../lib/api'
import { activityReducer, initialActivity } from '../lib/activity'
import { deriveOrbState } from '../lib/orbState'
import { LyraSocket, type ConnectionState } from '../lib/websocket'
import type { LyraEvent, LyraStatus, RuntimeState } from '../types/api'
import { useLyraWebSocket } from './useLyraWebSocket'

export const STATUS_POLL_MS = 30000
export const RESPONSE_PULSE_MS = 1400

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
  const [activity, dispatch] = useReducer(activityReducer, initialActivity)
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    if (event.type === 'state') setRuntime(event.state)
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
      if (state === 'closed') setRuntime('idle')
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
    },
    [],
  )

  const orbState = useMemo(
    () => deriveOrbState({ connection, runtime, responding }),
    [connection, runtime, responding],
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
    activity: activity.entries,
    clearActivity,
    refreshStatus,
  }
}

export type LyraLive = ReturnType<typeof useLyraState>
