import type { LyraEvent } from '../types/api'
import { getApiToken } from './api'

export type ConnectionState = 'connecting' | 'open' | 'closed'

type EventListener = (event: LyraEvent) => void
type ConnectionListener = (state: ConnectionState) => void

export interface SocketLike {
  onopen: ((ev: Event) => void) | null
  onclose: ((ev: CloseEvent) => void) | null
  onerror: ((ev: Event) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  close(): void
}

export interface LyraSocketOptions {
  url?: string
  create?: (url: string, protocols?: string[]) => SocketLike
  /** First retry delay; doubles per failure up to maxDelay, with ±20% jitter. */
  baseDelay?: number
  maxDelay?: number
  random?: () => number
}

export function defaultWsUrl(loc: Location = window.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${loc.host}/ws`
}

export function backoffDelay(attempt: number, base: number, max: number, random: () => number) {
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1))
  return Math.round(raw * (0.8 + random() * 0.4))
}

const KNOWN = new Set(['state', 'tool_started', 'tool_finished', 'response', 'error'])

export function parseEvent(data: unknown): LyraEvent | null {
  if (typeof data !== 'string') return null
  try {
    const event = JSON.parse(data)
    return event && typeof event === 'object' && KNOWN.has(event.type) ? (event as LyraEvent) : null
  } catch {
    return null
  }
}

/**
 * One shared connection to /ws with automatic reconnection.
 * Delays grow 1s → 2s → 4s … up to 30s (jittered, so many tabs do not reconnect
 * in lockstep); a successful open resets the sequence. Server → client only.
 */
export class LyraSocket {
  private socket: SocketLike | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = true
  private state: ConnectionState = 'closed'
  private readonly events = new Set<EventListener>()
  private readonly connection = new Set<ConnectionListener>()
  private readonly url: string
  private readonly create: (url: string, protocols?: string[]) => SocketLike
  private readonly baseDelay: number
  private readonly maxDelay: number
  private readonly random: () => number

  constructor(options: LyraSocketOptions = {}) {
    this.url = options.url ?? defaultWsUrl()
    this.create =
      options.create ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike)
    this.baseDelay = options.baseDelay ?? 1000
    this.maxDelay = options.maxDelay ?? 30000
    this.random = options.random ?? Math.random
  }

  get connectionState() {
    return this.state
  }

  get retryAttempt() {
    return this.attempt
  }

  onEvent(listener: EventListener) {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }

  onConnection(listener: ConnectionListener) {
    this.connection.add(listener)
    listener(this.state)
    return () => this.connection.delete(listener)
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.open()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null
      socket.close()
    }
    this.setState('closed')
  }

  /** Reconnect now (e.g. page became visible again) instead of waiting for the timer. */
  retryNow() {
    if (this.stopped || this.socket) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.open()
  }

  private setState(state: ConnectionState) {
    if (state === this.state) return
    this.state = state
    this.connection.forEach((listener) => listener(state))
  }

  private open() {
    this.setState('connecting')
    const token = getApiToken()
    // Browsers cannot send headers on WebSocket: the API accepts "bearer.<token>".
    const socket = this.create(this.url, token ? [`bearer.${token}`] : undefined)
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.setState('open')
    }
    socket.onmessage = (message) => {
      const event = parseEvent(message.data)
      if (event) this.events.forEach((listener) => listener(event))
    }
    socket.onerror = () => {
      // onclose follows and schedules the retry.
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.setState('closed')
      this.schedule()
    }
  }

  private schedule() {
    if (this.stopped || this.timer) return
    this.attempt += 1
    const delay = backoffDelay(this.attempt, this.baseDelay, this.maxDelay, this.random)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.stopped) this.open()
    }, delay)
  }
}
