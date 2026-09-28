/**
 * One utterance of audio from the live microphone stream, in memory only.
 * Each utterance gets its own MediaRecorder, started when the VAD hears a
 * candidate and stopped (or discarded) when it ends; the stream stays open.
 */

export interface UtteranceRecorder {
  start: () => void
  /** Finish and hand over the audio (null if nothing was captured). */
  stop: () => Promise<Blob | null>
  /** Discard everything captured. */
  cancel: () => void
  readonly mimeType: string
}

// Opus in WebM (Chrome, Firefox, recent Safari), AAC in MP4 (Safari/iOS).
const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus']

/** Supported container, '' for the browser default, null if recording is impossible. */
export function pickRecorderMimeType(): string | null {
  const Recorder = globalThis.MediaRecorder
  if (typeof Recorder !== 'function') return null
  if (typeof Recorder.isTypeSupported !== 'function') return ''
  return CANDIDATES.find((type) => Recorder.isTypeSupported(type)) ?? ''
}

export function createUtteranceRecorder(stream: MediaStream, mimeType: string): UtteranceRecorder {
  const chunks: Blob[] = []
  let recorder: MediaRecorder | null = null
  let done: Promise<Blob | null> | null = null

  const finish = (keep: boolean): Promise<Blob | null> => {
    const current = recorder
    recorder = null
    if (!current) return done ?? Promise.resolve(null)
    done = new Promise((resolve) => {
      const complete = () => {
        const type = current.mimeType || mimeType || 'audio/webm'
        const blob = keep && chunks.length ? new Blob(chunks, { type }) : null
        chunks.length = 0
        resolve(blob)
      }
      if (current.state === 'inactive') {
        complete()
        return
      }
      current.addEventListener('stop', complete, { once: true })
      try {
        current.stop()
      } catch {
        complete()
      }
    })
    return done
  }

  return {
    start: () => {
      if (recorder) return
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data?.size) chunks.push(event.data)
        })
        recorder.start()
      } catch {
        recorder = null
      }
    },
    stop: () => finish(true),
    cancel: () => {
      void finish(false)
    },
    get mimeType() {
      return recorder?.mimeType || mimeType
    },
  }
}
