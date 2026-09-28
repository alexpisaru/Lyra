/**
 * Voice activity detection, local to the device. The conversation only sees
 * these events, so the energy detector can later be swapped for Silero VAD
 * without touching the UI, the recorder or the transport.
 */

export interface VadConfig {
  /** Starting guess for the background noise level (dBFS). */
  initialFloorDb: number
  /** How fast the noise floor may rise while quiet (dB per second); it falls at once. */
  floorRiseDbPerSec: number
  /** Level above the floor that opens a speech candidate (dB). */
  startMarginDb: number
  /** Lower level that keeps speech going (hysteresis, dB above the floor). */
  continueMarginDb: number
  /** Absolute minimum for speech, whatever the floor (dBFS). */
  minSpeechDb: number
  /** Sustained sound needed before a candidate becomes speech (ms). */
  minSpeechMs: number
  /** Dips shorter than this do not cancel a candidate (ms). */
  candidateGapMs: number
  /** Silence that ends an utterance; pauses between words are shorter (ms). */
  endSilenceMs: number
  /** Hard cap for one utterance (ms). */
  maxUtteranceMs: number
}

export type VadEvent =
  /** Sound above threshold: start capturing now so the first syllable is kept. */
  | { type: 'candidate'; at: number }
  /** It was a click or a bump, not speech: drop what was captured. */
  | { type: 'cancel'; at: number }
  /** Confirmed speech. */
  | { type: 'start'; at: number }
  /** The utterance is over. */
  | { type: 'end'; at: number; reason: 'silence' | 'max'; durationMs: number }

export interface VoiceActivityDetector {
  /** Feed one analysis frame: RMS amplitude (0..1) at time `now` (ms). */
  process: (rms: number, now: number) => VadEvent[]
  /** Forget any utterance in progress (keeps the learned noise floor). */
  reset: () => void
  readonly phase: 'quiet' | 'candidate' | 'speech'
}
