import { useCallback, useEffect, useRef, useState } from 'react'
import { createLevelMeter, type LevelMeter } from './levelMeter'
import { MIC_CONSTRAINTS, type MicPermission, type VoiceSession, type VoiceState } from './types'

function describe(error: unknown): { message: string; permission: MicPermission | null } {
  const name = error instanceof DOMException || error instanceof Error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { message: 'Accesso al microfono negato', permission: 'denied' }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { message: 'Nessun microfono disponibile', permission: null }
    case 'NotReadableError':
    case 'AbortError':
      return { message: 'Il microfono è occupato da un’altra app', permission: null }
    default:
      return { message: 'Impossibile aprire il microfono', permission: null }
  }
}

/**
 * The microphone session: opens it only from a user gesture, exposes a live
 * input level, and releases the physical microphone on stop, when the page is
 * hidden and on unmount. Nothing is recorded, stored or sent.
 */
export function useVoiceSession(): VoiceSession {
  const [voiceState, setVoiceState] = useState<VoiceState>('off')
  const [micPermission, setMicPermission] = useState<MicPermission>('unknown')
  const [hasLiveTrack, setHasLiveTrack] = useState(false)
  const [inputLevel, setInputLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const stream = useRef<MediaStream | null>(null)
  const meter = useRef<LevelMeter | null>(null)
  // Each start gets a new token; a stop (or a newer start) invalidates older ones,
  // so a getUserMedia that resolves late is released instead of being kept.
  const token = useRef(0)
  const mounted = useRef(true)

  /** Stop every track and close the audio graph. No React state here. */
  const release = useCallback(() => {
    token.current += 1
    const current = stream.current
    stream.current = null
    current?.getTracks().forEach((track) => track.stop())
    meter.current?.close()
    meter.current = null
  }, [])

  const stopListening = useCallback(() => {
    release()
    if (!mounted.current) return
    setHasLiveTrack(false)
    setInputLevel(0)
    setVoiceState((state) => (state === 'error' ? 'error' : 'off'))
  }, [release])

  const startListening = useCallback(async () => {
    release() // never two sessions at once
    const mine = token.current
    setError(null)
    const media = navigator.mediaDevices
    if (!media?.getUserMedia) {
      // e.g. plain-HTTP origin: the browser does not expose the microphone at all
      setMicPermission('unsupported')
      setError('Il microfono richiede una connessione sicura (HTTPS)')
      setVoiceState('error')
      return
    }
    // Inside the tap: iOS lets only a user gesture start an AudioContext, and
    // getUserMedia is invoked before any await so it keeps the gesture.
    const levels = createLevelMeter()
    let opened: MediaStream
    try {
      opened = await media.getUserMedia(MIC_CONSTRAINTS)
    } catch (failure) {
      levels.close()
      if (mine !== token.current || !mounted.current) return
      const { message, permission } = describe(failure)
      if (permission) setMicPermission(permission)
      setError(message)
      setVoiceState('error')
      return
    }
    if (mine !== token.current || !mounted.current) {
      // stopped (or hidden/unmounted) while the permission prompt was open
      opened.getTracks().forEach((track) => track.stop())
      levels.close()
      return
    }
    stream.current = opened
    meter.current = levels
    for (const track of opened.getAudioTracks()) {
      // The OS can take the microphone away (call, Siri, another app): go back to off.
      track.addEventListener('ended', () => {
        if (stream.current === opened) stopListening()
      })
    }
    setMicPermission('granted')
    setHasLiveTrack(opened.getAudioTracks().some((track) => track.readyState === 'live'))
    setInputLevel(0)
    setVoiceState('listening')
    levels.attach(opened, (level) => {
      if (stream.current === opened) setInputLevel(level)
    })
  }, [release, stopListening])

  // No background listening: hidden or leaving the page releases the microphone.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden' && stream.current) stopListening()
    }
    const onPageHide = () => {
      if (stream.current) stopListening()
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [stopListening])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      release()
    }
  }, [release])

  return { voiceState, micPermission, hasLiveTrack, inputLevel, error, startListening, stopListening }
}
