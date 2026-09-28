/**
 * Real-time input level of a MediaStream (proof the microphone is alive).
 * Nothing is recorded or kept: an AnalyserNode is read and discarded each frame.
 *
 * Works without WebAudio: when AudioContext is missing or fails, the meter
 * reports level 0 and the stream itself is unaffected.
 */

type AudioContextCtor = typeof AudioContext

export function audioContextClass(): AudioContextCtor | null {
  const w = window as Window & { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

export type FrameListener = (rms: number, now: number, running: boolean) => void

export interface LevelMeter {
  /**
   * Connect a stream and start reporting levels (0..1) for the UI, plus every
   * analysis frame (raw RMS, time, whether audio is running) for the VAD.
   */
  attach: (stream: MediaStream, onLevel: (level: number) => void, onFrame?: FrameListener) => void
  /** Disconnect nodes, stop the loop and close the AudioContext. Idempotent. */
  close: () => void
  readonly context: AudioContext | null
}

/**
 * Create the meter. Call it inside the user gesture (before awaiting
 * getUserMedia): iOS Safari only lets a gesture start an AudioContext.
 */
export function createLevelMeter(): LevelMeter {
  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let frame = 0
  let closed = false

  const Ctor = audioContextClass()
  if (Ctor) {
    try {
      context = new Ctor()
    } catch {
      context = null
    }
  }

  const attach: LevelMeter['attach'] = (stream, onLevel, onFrame) => {
    if (closed || !context) return
    try {
      source = context.createMediaStreamSource(stream)
      analyser = context.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser) // never to the destination: no playback, no feedback
      void context.resume?.().catch(() => undefined)
    } catch {
      disconnect()
      return
    }
    const data = new Float32Array(analyser.fftSize)
    let smoothed = 0
    let last = 0
    let lastResume = 0
    const tick = (now: number) => {
      if (closed || !analyser || !context) return
      frame = requestAnimationFrame(tick)
      // iOS suspends/interrupts the context (calls, Siri): try to resume, tell the VAD
      const running = context.state === 'running'
      if (!running && now - lastResume > 1000) {
        lastResume = now
        void context.resume?.().catch(() => undefined)
      }
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      onFrame?.(rms, now, running)
      // speech RMS is ~0.01..0.2: map to 0..1 on a soft curve
      const level = Math.min(1, Math.sqrt(rms * 6))
      smoothed = smoothed * 0.7 + level * 0.3
      if (now - last > 66) {
        // ~15 updates/s is plenty for a UI indicator
        last = now
        onLevel(Math.round(smoothed * 100) / 100)
      }
    }
    frame = requestAnimationFrame(tick)
  }

  const disconnect = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    try {
      source?.disconnect()
    } catch {
      /* already disconnected */
    }
    try {
      analyser?.disconnect()
    } catch {
      /* already disconnected */
    }
    source = null
    analyser = null
  }

  const close = () => {
    if (closed) return
    closed = true
    disconnect()
    const ctx = context
    context = null
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }

  return {
    attach,
    close,
    get context() {
      return context
    },
  }
}
