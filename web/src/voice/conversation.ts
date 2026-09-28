import { sameIds, type VoiceIds } from './identity'
import type { SpeechPlayer } from './player'
import type { UtteranceRecorder } from './recorder'
import { chunkSpeech, toSpeech } from './speechText'
import type { VoiceState } from './types'
import type { VadEvent, VoiceActivityDetector } from './vad/types'

/**
 * One mic conversation (one voice_session_id), without React or DOM:
 *
 *   LISTENING -(VAD end)-> THINKING: transcribe -> chat -> SPEAKING -> LISTENING
 *
 * The spoken text goes through the SAME chat path as typed text (`converse`),
 * so the turn appears in Chat and uses Lyra's normal history. Audio only ever
 * plays for this session's current turn: every async step re-checks the ids,
 * so a late answer for a stopped session or an older turn is dropped.
 */

export interface ConverseResult {
  ok: boolean
  reply: string | null
  error?: string | null
}

export interface ConversationDeps {
  clientId: () => string
  newId: () => string
  vad: VoiceActivityDetector
  /** A recorder on the live stream, or null when this browser cannot record. */
  createRecorder: () => UtteranceRecorder | null
  transcribe: (audio: Blob, ids: VoiceIds, signal: AbortSignal) => Promise<{ ids: VoiceIds; text: string }>
  converse: (text: string) => Promise<ConverseResult>
  speak: (text: string, ids: VoiceIds, signal: AbortSignal) => Promise<{ ids: VoiceIds; audio: ArrayBuffer; mimeType?: string }>
  player: SpeechPlayer
  onState: (state: VoiceState, error: string | null) => void
  /** The mic can no longer work (e.g. audio suspended): the owner stops the session. */
  onFatal: (message: string) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** VAD stays deaf this long after Lyra stops speaking (echo tail). */
  cooldownMs?: number
  /** How long a turn error stays visible before listening again. */
  errorHoldMs?: number
  /** Audio that stays unavailable this long ends the session. */
  suspendedLimitMs?: number
  /** Blobs smaller than this are treated as empty. */
  minAudioBytes?: number
}

export class VoiceConversation {
  readonly sessionId: string
  private readonly deps: ConversationDeps
  private active = true
  private state: VoiceState = 'listening'
  private turnId: string | null = null
  private recorder: UtteranceRecorder | null = null
  private controller = new AbortController()
  private deafUntil = 0
  private suspendedSince: number | null = null
  private timer: unknown = null

  constructor(deps: ConversationDeps) {
    this.deps = deps
    this.sessionId = deps.newId()
    this.set('listening', null)
  }

  get voiceState(): VoiceState {
    return this.state
  }

  get isActive(): boolean {
    return this.active
  }

  /** One analysis frame from the level meter. */
  frame(rms: number, now: number, audioRunning = true) {
    if (!this.active) return
    if (!audioRunning) {
      this.suspendedSince ??= now
      if (now - this.suspendedSince >= (this.deps.suspendedLimitMs ?? 3000)) {
        this.deps.onFatal('Audio sospeso dal sistema: tocca il microfono per riprendere')
      }
      return
    }
    this.suspendedSince = null
    // Only a listening session hears anything; Lyra's own voice is never an utterance.
    if (this.state !== 'listening' || now < this.deafUntil) return
    for (const event of this.deps.vad.process(rms, now)) this.onVad(event)
  }

  /** End the session: nothing started before this may still play. */
  stop() {
    if (!this.active) return
    this.active = false
    this.turnId = null
    this.controller.abort()
    this.clearTimer()
    this.recorder?.cancel()
    this.recorder = null
    this.deps.player.stop()
    this.deps.vad.reset()
  }

  /**
   * Phase 3 barge-in entry point: cut Lyra's speech and listen again. Not wired
   * to the VAD yet (the VAD is deaf while Lyra speaks).
   */
  interrupt() {
    if (!this.active || this.state !== 'speaking') return
    this.turnId = null
    this.controller.abort()
    this.controller = new AbortController()
    this.deps.player.stop()
    this.set('interrupted', null)
    this.listen()
  }

  private onVad(event: VadEvent) {
    switch (event.type) {
      case 'candidate':
        this.recorder?.cancel()
        this.recorder = this.deps.createRecorder()
        if (!this.recorder) {
          this.deps.onFatal('Questo browser non può registrare audio')
          return
        }
        this.recorder.start()
        break
      case 'cancel':
        this.recorder?.cancel()
        this.recorder = null
        break
      case 'start':
        break
      case 'end': {
        const recorder = this.recorder
        this.recorder = null
        if (recorder) void this.runTurn(recorder)
        break
      }
    }
  }

  private current(ids: VoiceIds): boolean {
    return (
      this.active &&
      ids.client_id === this.deps.clientId() &&
      ids.voice_session_id === this.sessionId &&
      ids.voice_turn_id === this.turnId
    )
  }

  private async runTurn(recorder: UtteranceRecorder) {
    const ids: VoiceIds = {
      client_id: this.deps.clientId(),
      voice_session_id: this.sessionId,
      voice_turn_id: this.deps.newId(),
    }
    this.turnId = ids.voice_turn_id
    const { signal } = this.controller
    this.set('thinking', null)

    const audio = await recorder.stop()
    if (!this.current(ids)) return
    if (!audio || audio.size < (this.deps.minAudioBytes ?? 1200)) return this.listen()

    let text: string
    try {
      const heard = await this.deps.transcribe(audio, ids, signal)
      if (!this.current(ids) || !sameIds(heard.ids, ids)) return
      text = heard.text.trim()
    } catch {
      if (this.current(ids)) this.fail('Non ho capito: trascrizione non riuscita')
      return
    }
    if (!text) return this.listen() // silence or noise: nothing to answer

    let result: ConverseResult
    try {
      result = await this.deps.converse(text)
    } catch {
      result = { ok: false, reply: null }
    }
    if (!this.current(ids)) return // the reply is in Chat; it is just not spoken
    if (!result.ok || !result.reply) return this.fail(result.error || 'Lyra non ha risposto')

    const chunks = chunkSpeech(toSpeech(result.reply))
    if (!chunks.length) return this.listen()
    this.set('speaking', null)
    try {
      await this.speakAll(chunks, ids, signal)
    } catch {
      if (this.current(ids)) this.fail('Voce di Lyra non disponibile')
      return
    }
    if (this.current(ids)) this.listen()
  }

  /** Synthesize chunk i+1 while chunk i plays; stop at the first stale step. */
  private async speakAll(chunks: string[], ids: VoiceIds, signal: AbortSignal) {
    let next = this.deps.speak(chunks[0], ids, signal)
    for (let i = 0; i < chunks.length; i += 1) {
      const spoken = await next
      if (!this.current(ids) || !sameIds(spoken.ids, ids)) return
      if (i + 1 < chunks.length) {
        next = this.deps.speak(chunks[i + 1], ids, signal)
        next.catch(() => undefined) // surfaced when awaited
      }
      const completed = await this.deps.player.play(spoken.audio, spoken.mimeType)
      if (!completed) return
    }
  }

  private listen() {
    if (!this.active) return
    this.turnId = null
    this.clearTimer()
    this.deps.vad.reset()
    this.deafUntil = this.now() + (this.deps.cooldownMs ?? 400)
    this.set('listening', null)
  }

  /** A turn failed: show it briefly, then keep the conversation usable. */
  private fail(message: string) {
    if (!this.active) return
    this.turnId = null
    this.set('error', message)
    this.clearTimer()
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.timer = setTimer(() => {
      this.timer = null
      if (this.active && this.state === 'error') this.listen()
    }, this.deps.errorHoldMs ?? 2500)
  }

  private clearTimer() {
    if (this.timer === null) return
    const clear = this.deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    clear(this.timer)
    this.timer = null
  }

  private now() {
    return (this.deps.now ?? (() => performance.now()))()
  }

  private set(state: VoiceState, error: string | null) {
    this.state = state
    if (this.active) this.deps.onState(state, error)
  }
}
