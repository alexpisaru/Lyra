import type { CSSProperties } from 'react'
import type { VoiceSession } from '../voice/types'
import { MicIcon, MicOffIcon } from './icons'

/**
 * Microphone toggle. The tap itself starts the session (iOS requires the
 * permission request to come from a user gesture). While the conversation is
 * on (listening, thinking, speaking) a tap ends it; a subtle level ring shows
 * the live input while listening.
 */
export function MicButton({ voice }: { voice: VoiceSession }) {
  const { voiceState, inputLevel, error } = voice
  const listening = voiceState === 'listening'
  // A turn error keeps the mic open (the conversation goes on); a mic error does not.
  const active = voice.hasLiveTrack || (voiceState !== 'off' && voiceState !== 'error')
  const failed = voiceState === 'error' && !active
  const label = active
    ? 'Disattiva il microfono'
    : failed
      ? `Microfono non disponibile: ${error ?? 'errore'}. Tocca per riprovare`
      : 'Attiva il microfono'
  return (
    <button
      type="button"
      className="composer-icon mic-button"
      data-voice={voiceState}
      aria-pressed={active}
      aria-label={label}
      title={voiceState === 'error' && error ? error : active ? 'Microfono attivo' : 'Microfono'}
      style={{ '--level': listening ? inputLevel : 0 } as CSSProperties}
      onClick={() => {
        if (active) voice.stopListening()
        else void voice.startListening()
      }}
    >
      {failed ? <MicOffIcon size={21} /> : <MicIcon size={21} />}
    </button>
  )
}
