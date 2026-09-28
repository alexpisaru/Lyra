/**
 * Lyra Voice. Phase 1 only opens and releases the microphone on an explicit
 * tap: no wake word, no STT/VAD/TTS, no audio leaves the device.
 *
 * States used in Phase 1: off, listening, error. thinking / speaking /
 * interrupted are declared for the later phases (STT -> Lyra -> TTS).
 */
export type VoiceState = 'off' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error'

export const VOICE_STATES: readonly VoiceState[] = [
  'off',
  'listening',
  'thinking',
  'speaking',
  'interrupted',
  'error',
]

/** What the browser told us about microphone access. */
export type MicPermission = 'unknown' | 'granted' | 'denied' | 'unsupported'

/** Constraints requested on every start (the browser may ignore some). */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
}

export interface VoiceSession {
  voiceState: VoiceState
  micPermission: MicPermission
  /** true while a microphone track is actually live */
  hasLiveTrack: boolean
  /** 0..1, smoothed RMS of the input; 0 when no level meter is available */
  inputLevel: number
  /** user-facing reason of the last failure, null otherwise */
  error: string | null
  /** Must be called directly from a user gesture (tap/click handler). */
  startListening: () => Promise<void>
  /** Releases the physical microphone (tracks stopped, audio graph closed). */
  stopListening: () => void
}
