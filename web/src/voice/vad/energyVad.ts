import type { VadConfig, VadEvent, VoiceActivityDetector } from './types'

/** All VAD thresholds in one place. */
export const DEFAULT_VAD_CONFIG: VadConfig = {
  initialFloorDb: -60,
  floorRiseDbPerSec: 3,
  startMarginDb: 14,
  continueMarginDb: 8,
  minSpeechDb: -48,
  minSpeechMs: 200,
  candidateGapMs: 90,
  endSilenceMs: 800,
  maxUtteranceMs: 15000,
}

export function toDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-5))
}

/**
 * Energy VAD over the level meter's RMS: an adaptive noise floor, a start
 * threshold, a lower continue threshold (hysteresis), a minimum speech time,
 * a silence time that ends the utterance and a maximum utterance length.
 */
export function createEnergyVad(overrides: Partial<VadConfig> = {}): VoiceActivityDetector {
  const config = { ...DEFAULT_VAD_CONFIG, ...overrides }
  let floor = config.initialFloorDb
  let phase: VoiceActivityDetector['phase'] = 'quiet'
  let startedAt = 0
  let lastLoud = 0
  let lastFrame: number | null = null

  const thresholds = () => ({
    start: Math.max(floor + config.startMarginDb, config.minSpeechDb),
    keep: Math.max(floor + config.continueMarginDb, config.minSpeechDb - 6),
  })

  const process = (rms: number, now: number): VadEvent[] => {
    const db = toDb(rms)
    const dt = lastFrame === null ? 0 : Math.max(0, now - lastFrame)
    lastFrame = now
    const { start, keep } = thresholds()

    if (phase === 'quiet') {
      if (db >= start) {
        phase = 'candidate'
        startedAt = now
        lastLoud = now
        return [{ type: 'candidate', at: now }]
      }
      // learn the room: drop quickly to quieter levels, rise slowly
      floor = db < floor ? floor + (db - floor) * 0.3 : Math.min(db, floor + (config.floorRiseDbPerSec * dt) / 1000)
      return []
    }

    if (db >= keep) lastLoud = now

    if (phase === 'candidate') {
      if (now - lastLoud > config.candidateGapMs) {
        phase = 'quiet'
        return [{ type: 'cancel', at: now }]
      }
      if (now - startedAt >= config.minSpeechMs) {
        phase = 'speech'
        return [{ type: 'start', at: startedAt }]
      }
      return []
    }

    // speech
    const durationMs = now - startedAt
    if (now - lastLoud >= config.endSilenceMs) {
      phase = 'quiet'
      return [{ type: 'end', at: now, reason: 'silence', durationMs }]
    }
    if (durationMs >= config.maxUtteranceMs) {
      phase = 'quiet'
      return [{ type: 'end', at: now, reason: 'max', durationMs }]
    }
    return []
  }

  return {
    process,
    reset: () => {
      phase = 'quiet'
      lastFrame = null
    },
    get phase() {
      return phase
    },
  }
}
