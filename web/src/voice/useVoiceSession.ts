import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { VoiceConversation, type ConversationDeps, type ConverseResult } from './conversation'
import { getClientId, newVoiceId } from './identity'
import { createLevelMeter, type LevelMeter } from './levelMeter'
import { createSpeechPlayer } from './player'
import { createUtteranceRecorder, pickRecorderMimeType } from './recorder'
import { MIC_CONSTRAINTS, type MicPermission, type VoiceSession, type VoiceState } from './types'
import { createEnergyVad } from './vad/energyVad'

export interface VoiceSessionOptions {
  /**
   * The conversation path for spoken text: the same chat send as typed text.
   * Without it the session only opens the mic and shows the level (Phase 1).
   */
  converse?: (text: string) => Promise<ConverseResult>
  /** Test seam: replace transport/audio pieces of the conversation. */
  conversation?: Partial<ConversationDeps>
}

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
 * hidden and on unmount. With `converse` it also runs the voice conversation
 * (local VAD -> utterance -> STT -> chat -> TTS on this device); utterances
 * live in memory only for their own request, nothing is stored.
 */
export function useVoiceSession(options: VoiceSessionOptions = {}): VoiceSession {
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
  const conversation = useRef<VoiceConversation | null>(null)
  // Latest options for callbacks created at start (the chat send changes identity).
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  /** Stop every track and close the audio graph. No React state here. */
  const release = useCallback(() => {
    token.current += 1
    conversation.current?.stop()
    conversation.current = null
    const current = stream.current
    stream.current = null
    current?.getTracks().forEach((track) => track.stop())
    meter.current?.close()
    meter.current = null
  }, [])

  const stopListening = useCallback(() => {
    // A live session ends in off; a failed open keeps showing its error.
    const hadSession = stream.current !== null
    release()
    if (!mounted.current) return
    setHasLiveTrack(false)
    setInputLevel(0)
    if (hadSession) setError(null)
    setVoiceState((state) => (state === 'error' && !hadSession ? 'error' : 'off'))
  }, [release])

  /** The mic cannot go on (audio suspended, no recorder): release it and say why. */
  const failSession = useCallback(
    (message: string) => {
      release()
      if (!mounted.current) return
      setHasLiveTrack(false)
      setInputLevel(0)
      setError(message)
      setVoiceState('error')
    },
    [release],
  )

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

    const converse = latest.current.converse
    let talk: VoiceConversation | null = null
    if (converse) {
      const mimeType = pickRecorderMimeType()
      talk = new VoiceConversation({
        clientId: getClientId,
        newId: newVoiceId,
        vad: createEnergyVad(),
        createRecorder: () => (mimeType === null ? null : createUtteranceRecorder(opened, mimeType)),
        transcribe: async (audio, ids, signal) => {
          const heard = await api.transcribe(audio, ids, signal)
          return { ids: heard, text: heard.text }
        },
        converse: (text) => (latest.current.converse ?? converse)(text),
        speak: api.speak,
        player: createSpeechPlayer(() => levels.context),
        onState: (state, message) => {
          if (conversation.current !== talk || !mounted.current) return
          setVoiceState(state)
          setError(message)
        },
        onFatal: (message) => {
          if (conversation.current === talk) failSession(message)
        },
        ...latest.current.conversation,
      })
      conversation.current = talk
    }
    levels.attach(
      opened,
      (level) => {
        if (stream.current === opened) setInputLevel(level)
      },
      (rms, now, running) => {
        if (conversation.current === talk) talk?.frame(rms, now, running)
      },
    )
  }, [release, stopListening, failSession])

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
