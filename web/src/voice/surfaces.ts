import type { VoiceState } from './types'

/**
 * Where Lyra Voice lives. Home (primary) and Chat are two controls on the ONE
 * session owned by App: moving between them keeps the microphone as it is.
 * Any other view has no mic control, so entering it releases the microphone.
 *
 * Phase 2 attaches to the same session and the same conversation as Chat:
 *   audio -> VAD -> STT -> chat.send(text) (useChat, shared with Chat) -> TTS
 * so a spoken turn and Lyra's answer appear in the Chat history.
 */
export const VOICE_SURFACES = ['home', 'chat'] as const

export function isVoiceSurface(view: string): boolean {
  return (VOICE_SURFACES as readonly string[]).includes(view)
}

/** Line under the orb for the voice state (null = say nothing). */
export function voiceCaption(state: VoiceState, error: string | null): string | null {
  switch (state) {
    case 'listening':
      return 'Ti ascolto…'
    case 'thinking':
      return 'Sto pensando…'
    case 'speaking':
      return 'Sto parlando…'
    case 'interrupted':
      return 'Interrotto'
    case 'error':
      return error ?? 'Microfono non disponibile'
    default:
      return null
  }
}
