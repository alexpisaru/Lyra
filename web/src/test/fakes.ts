import { vi } from 'vitest'
import { LyraSocket, type SocketLike } from '../lib/websocket'
import type { LyraEvent, LyraStatus } from '../types/api'

export const STATUS: LyraStatus = {
  status: 'ok',
  name: 'Lyra',
  version: '0.3.0',
  state: 'idle',
  busy: false,
  model: { provider: 'ollama', model: 'openbmb/minicpm5-2b:q8_0', reachable: true },
  memory: { enabled: true },
  knowledge: { enabled: true },
  browser: { enabled: true, backend: 'chromium' },
  packs: ['auto', 'chat', 'general', 'files', 'memory', 'knowledge', 'browser'],
}

/** In-memory stand-in for the browser WebSocket. */
export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = []
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  closed = false
  readonly url: string
  readonly protocols?: string[]

  constructor(url: string, protocols?: string[]) {
    this.url = url
    this.protocols = protocols
    FakeSocket.instances.push(this)
  }

  open() {
    this.onopen?.(new Event('open'))
  }

  emit(event: LyraEvent) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }))
  }

  drop() {
    this.onclose?.(new CloseEvent('close'))
  }

  close() {
    this.closed = true
  }

  static latest() {
    return FakeSocket.instances[FakeSocket.instances.length - 1]
  }
}

export function fakeSocket() {
  FakeSocket.instances = []
  return new LyraSocket({
    url: 'ws://test/ws',
    create: (url, protocols) => new FakeSocket(url, protocols),
    random: () => 0.5,
  })
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Stubs global fetch with a tiny router; unmatched calls fail like a dead proxy. */
export function mockFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!key) throw new TypeError('Failed to fetch')
    return routes[key](url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
