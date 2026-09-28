import type { CSSProperties } from 'react'
import type { VoiceSession } from '../voice/types'
import { MicIcon, MicOffIcon } from './icons'

/**
 * Microphone toggle. The tap itself starts the session (iOS requires the
 * permission request to come from a user gesture). No STT yet: while listening
 * it only shows that the stream is alive, via a subtle level ring.
 */
export function MicButton({ voice }: { voice: VoiceSession }) {
  const { voiceState, inputLevel, error } = voice
  const listening = voiceState === 'listening'
  const failed = voiceState === 'error'
  const label = listening
    ? 'Disattiva il microfono'
    : failed
      ? `Microfono non disponibile: ${error ?? 'errore'}. Tocca per riprovare`
      : 'Attiva il microfono'
  return (
    <button
      type="button"
      className="composer-icon mic-button"
      data-voice={voiceState}
      aria-pressed={listening}
      aria-label={label}
      title={failed && error ? error : listening ? 'Microfono attivo' : 'Microfono'}
      style={{ '--level': listening ? inputLevel : 0 } as CSSProperties}
      onClick={() => {
        if (listening) voice.stopListening()
        else void voice.startListening()
      }}
    >
      {failed ? <MicOffIcon size={21} /> : <MicIcon size={21} />}
    </button>
  )
}
