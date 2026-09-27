import { useEffect, useState } from 'react'
import type { LyraEvent } from '../types/api'
import { LyraSocket, type ConnectionState } from '../lib/websocket'

/**
 * Starts the shared /ws connection for the lifetime of the component and
 * forwards every event to `onEvent`. Reconnects immediately when the page
 * becomes visible again (iOS suspends sockets in background tabs).
 */
export function useLyraWebSocket(
  socket: LyraSocket,
  onEvent: (event: LyraEvent) => void,
  onConnection?: (state: ConnectionState) => void,
) {
  const [connection, setConnection] = useState<ConnectionState>(socket.connectionState)

  useEffect(() => {
    const offEvent = socket.onEvent(onEvent)
    const offConnection = socket.onConnection((state) => {
      setConnection(state)
      onConnection?.(state)
    })
    socket.start()
    const onVisible = () => {
      if (document.visibilityState === 'visible') socket.retryNow()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
      offEvent()
      offConnection()
      socket.stop()
    }
  }, [socket, onEvent, onConnection])

  return connection
}
