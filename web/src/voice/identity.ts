/**
 * Voice identities. No fingerprinting: client_id is a random UUID kept in this
 * browser/PWA's localStorage, so each installation is one client.
 *
 *   client_id         one per device/installation (persisted)
 *   voice_session_id  one per mic conversation (new on every start)
 *   voice_turn_id     one per utterance
 */

export interface VoiceIds {
  client_id: string
  voice_session_id: string
  voice_turn_id: string
}

const CLIENT_KEY = 'lyra.clientId'
const VALID = /^[A-Za-z0-9-]{8,64}$/
let fallbackClientId: string | null = null

export function newVoiceId(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function getClientId(): string {
  try {
    const stored = localStorage.getItem(CLIENT_KEY)
    if (stored && VALID.test(stored)) return stored
  } catch {
    // blocked storage: keep one id for this page's lifetime
  }
  fallbackClientId ??= newVoiceId()
  try {
    localStorage.setItem(CLIENT_KEY, fallbackClientId)
  } catch {
    // same
  }
  return fallbackClientId
}

export function sameIds(a: VoiceIds, b: VoiceIds): boolean {
  return (
    a.client_id === b.client_id && a.voice_session_id === b.voice_session_id && a.voice_turn_id === b.voice_turn_id
  )
}
