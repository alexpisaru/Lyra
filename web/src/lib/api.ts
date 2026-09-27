import type { ChatResponse, LyraStatus, NoteResponse, Pack, SearchResponse } from '../types/api'

/**
 * The only place that talks HTTP to Lyra API. Same origin: in production Caddy
 * proxies /api to 127.0.0.1:8787, in development Vite does.
 *
 * Auth is prepared, not built: if the API gets an api_key, a future settings
 * screen can call setApiToken(). No secret is ever bundled in the frontend.
 */

export type ApiErrorKind = 'offline' | 'busy' | 'unauthorized' | 'invalid' | 'not_found' | 'server'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number

  constructor(kind: ApiErrorKind, status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

const TOKEN_KEY = 'lyra.apiToken'

export function getApiToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setApiToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Private mode / blocked storage: auth simply stays off.
  }
}

function kindFor(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 409) return 'busy'
  if (status === 400 || status === 415 || status === 422) return 'invalid'
  if (status === 502 || status === 503 || status === 504) return 'offline'
  return 'server'
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getApiToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let response: Response
  try {
    response = await fetch(path, { ...init, headers, cache: 'no-store' })
  } catch {
    throw new ApiError('offline', 0, 'Lyra non raggiungibile')
  }
  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = await response.json()
      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      // Proxy error pages are not JSON.
    }
    const kind = kindFor(response.status)
    throw new ApiError(kind, response.status, kind === 'offline' ? 'Lyra non raggiungibile' : detail)
  }
  return (await response.json()) as T
}

export const api = {
  status: (signal?: AbortSignal) => request<LyraStatus>('/api/status', { signal }),

  chat: (message: string, pack: Pack = 'auto') =>
    request<ChatResponse>('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, pack }),
    }),

  resetChat: () => request<{ status: 'ok'; cleared_exchanges: number }>('/api/chat/reset', { method: 'POST' }),

  searchNotes: (q: string, signal?: AbortSignal) =>
    request<SearchResponse>(`/api/knowledge/search?q=${encodeURIComponent(q)}`, { signal }),

  readNote: (path: string, signal?: AbortSignal) =>
    request<NoteResponse>(`/api/knowledge/note?path=${encodeURIComponent(path)}`, { signal }),
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.kind) {
      case 'offline':
        return 'Lyra non raggiungibile'
      case 'busy':
        return 'Lyra sta già lavorando a una richiesta'
      case 'unauthorized':
        return 'Accesso non autorizzato'
      default:
        return error.message
    }
  }
  return 'Errore inatteso'
}
