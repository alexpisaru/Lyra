/**
 * Plays Lyra's speech on this device. It uses the voice session's own
 * AudioContext (started inside the mic tap, so iOS allows playback without a
 * further gesture); without WebAudio it falls back to an <audio> element.
 * stop() cuts playback at once: the hook Phase 3 barge-in will use.
 */

export interface SpeechPlayer {
  /** Resolves true when the clip played to the end, false if it was stopped. */
  play: (audio: ArrayBuffer, mimeType?: string) => Promise<boolean>
  stop: () => void
}

export function createSpeechPlayer(getContext: () => AudioContext | null): SpeechPlayer {
  let stopCurrent: (() => void) | null = null

  const stop = () => {
    const current = stopCurrent
    stopCurrent = null
    current?.()
  }

  const playWithContext = async (context: AudioContext, audio: ArrayBuffer) => {
    if (context.state !== 'running') await context.resume().catch(() => undefined)
    const buffer = await context.decodeAudioData(audio.slice(0))
    return new Promise<boolean>((resolve) => {
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      let settled = false
      const settle = (completed: boolean) => {
        if (settled) return
        settled = true
        if (stopCurrent === cancel) stopCurrent = null
        try {
          source.disconnect()
        } catch {
          /* already disconnected */
        }
        resolve(completed)
      }
      const cancel = () => {
        try {
          source.stop()
        } catch {
          /* not started */
        }
        settle(false)
      }
      source.onended = () => settle(true)
      stopCurrent = cancel
      source.start()
    })
  }

  const playWithElement = (audio: ArrayBuffer, mimeType: string) =>
    new Promise<boolean>((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([audio], { type: mimeType }))
      const element = new Audio(url)
      let settled = false
      const settle = (outcome: boolean | Error) => {
        if (settled) return
        settled = true
        if (stopCurrent === cancel) stopCurrent = null
        element.pause()
        element.removeAttribute('src')
        URL.revokeObjectURL(url)
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }
      const cancel = () => settle(false)
      element.onended = () => settle(true)
      element.onerror = () => settle(new Error('audio playback failed'))
      stopCurrent = cancel
      element.play().catch(() => settle(new Error('audio playback failed')))
    })

  return {
    play: (audio, mimeType = 'audio/wav') => {
      stop() // one voice at a time
      const context = getContext()
      return context ? playWithContext(context, audio) : playWithElement(audio, mimeType)
    },
    stop,
  }
}
