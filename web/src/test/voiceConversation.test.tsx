import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useChat } from '../hooks/useChat'
import { VoiceConversation, type ConversationDeps, type ConverseResult } from '../voice/conversation'
import { getClientId, newVoiceId, type VoiceIds } from '../voice/identity'
import type { SpeechPlayer } from '../voice/player'
import { createUtteranceRecorder, pickRecorderMimeType, type UtteranceRecorder } from '../voice/recorder'
import { chunkSpeech, toSpeech } from '../voice/speechText'
import type { VoiceState } from '../voice/types'
import { createEnergyVad, DEFAULT_VAD_CONFIG } from '../voice/vad/energyVad'
import type { VadEvent } from '../voice/vad/types'

// ---------------------------------------------------------------- helpers

const QUIET = 0.001 // -60 dBFS
const SPEECH = 0.05 // about -26 dBFS
const FRAME = 16

/** Feed `ms` of a constant level into a VAD starting at `t`; returns [events, end time]. */
function feed(vad: ReturnType<typeof createEnergyVad>, rms: number, ms: number, t: number) {
  const events: VadEvent[] = []
  let now = t
  for (; now < t + ms; now += FRAME) events.push(...vad.process(rms, now))
  return [events, now] as const
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

interface Harness {
  conversation: VoiceConversation
  deps: ConversationDeps
  states: VoiceState[]
  errors: (string | null)[]
  recorders: (UtteranceRecorder & { started: boolean; cancelled: boolean; stopped: boolean })[]
  played: ArrayBuffer[]
  spoken: { text: string; ids: VoiceIds }[]
  heard: VoiceIds[]
  fatal: string[]
  timers: (() => void)[]
  /** Speak an utterance through the real VAD: speech then enough silence. */
  utter: () => Promise<void>
  /** Same frames, without waiting for the turn to finish. */
  speakFrames: () => void
  t: { now: number }
}

function makeConversation(overrides: Partial<ConversationDeps> = {}, clientId = 'client-aaaaaaaa'): Harness {
  let counter = 0
  const t = { now: 0 }
  const states: VoiceState[] = []
  const errors: (string | null)[] = []
  const recorders: Harness['recorders'] = []
  const played: ArrayBuffer[] = []
  const spoken: Harness['spoken'] = []
  const heard: VoiceIds[] = []
  const fatal: string[] = []
  const timers: (() => void)[] = []
  const player: SpeechPlayer = {
    play: vi.fn(async (audio: ArrayBuffer) => {
      played.push(audio)
      return true
    }),
    stop: vi.fn(),
  }
  const deps: ConversationDeps = {
    clientId: () => clientId,
    newId: () => `id-${String((counter += 1)).padStart(8, '0')}`,
    vad: createEnergyVad(),
    createRecorder: () => {
      const recorder = {
        started: false,
        cancelled: false,
        stopped: false,
        mimeType: 'audio/webm',
        start() {
          recorder.started = true
        },
        async stop() {
          recorder.stopped = true
          return new Blob([new Uint8Array(4000)], { type: 'audio/webm' })
        },
        cancel() {
          recorder.cancelled = true
        },
      }
      recorders.push(recorder)
      return recorder
    },
    transcribe: vi.fn(async (_audio: Blob, ids: VoiceIds) => {
      heard.push(ids)
      return { ids, text: 'che ore sono?' }
    }),
    converse: vi.fn(async (): Promise<ConverseResult> => ({ ok: true, reply: 'Sono le dieci. Buona giornata!' })),
    speak: vi.fn(async (text: string, ids: VoiceIds) => {
      spoken.push({ text, ids })
      return { ids, audio: new ArrayBuffer(8) }
    }),
    player,
    onState: (state, error) => {
      states.push(state)
      errors.push(error)
    },
    onFatal: (message) => fatal.push(message),
    now: () => t.now,
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => undefined,
    ...overrides,
  }
  const conversation = new VoiceConversation(deps)
  const speakFrames = () => {
    const start = t.now + 1000
    for (let now = t.now; now < start; now += FRAME) conversation.frame(QUIET, now)
    for (let now = start; now < start + 600; now += FRAME) conversation.frame(SPEECH, now)
    for (let now = start + 600; now < start + 1600; now += FRAME) conversation.frame(QUIET, now)
    t.now = start + 1600
  }
  const utter = async () => {
    speakFrames()
    await flush()
  }
  return { conversation, deps, states, errors, recorders, played, spoken, heard, fatal, timers, utter, speakFrames, t }
}

// ---------------------------------------------------------------- VAD

describe('local VAD (energy)', () => {
  it('brief noise does not trigger an utterance', () => {
    const vad = createEnergyVad()
    const quiet = feed(vad, QUIET, 1000, 0)[1]
    const [events, t] = feed(vad, SPEECH, 80, quiet) // a click / a bump
    const after = feed(vad, QUIET, 500, t)[0]
    const all = [...events, ...after].map((e) => e.type)
    expect(all).toEqual(['candidate', 'cancel'])
    expect(vad.phase).toBe('quiet')
  })

  it('speech starts only after the threshold is held for the minimum time', () => {
    const vad = createEnergyVad()
    const t0 = feed(vad, QUIET, 1000, 0)[1]
    const [events] = feed(vad, SPEECH, DEFAULT_VAD_CONFIG.minSpeechMs + 40, t0)
    expect(events.map((e) => e.type)).toEqual(['candidate', 'start'])
    expect(events[1].at).toBe(t0) // start is dated at the onset
  })

  it('quiet room noise below the threshold never starts speech', () => {
    const vad = createEnergyVad()
    const [events] = feed(vad, 0.004, 3000, 0) // steady fan noise around -48 dBFS
    expect(events).toEqual([])
  })

  it('a short pause between words does not end the utterance', () => {
    const vad = createEnergyVad()
    let t = feed(vad, QUIET, 1000, 0)[1]
    t = feed(vad, SPEECH, 500, t)[1]
    const [pause, t2] = feed(vad, QUIET, 400, t) // between words
    const [more] = feed(vad, SPEECH, 500, t2)
    expect([...pause, ...more]).toEqual([])
    expect(vad.phase).toBe('speech')
  })

  it('sustained silence ends the utterance', () => {
    const vad = createEnergyVad()
    let t = feed(vad, QUIET, 1000, 0)[1]
    t = feed(vad, SPEECH, 600, t)[1]
    const [events] = feed(vad, QUIET, DEFAULT_VAD_CONFIG.endSilenceMs + 50, t)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'end', reason: 'silence' })
  })

  it('the maximum utterance duration ends it safely', () => {
    const vad = createEnergyVad({ maxUtteranceMs: 2000 })
    const t = feed(vad, QUIET, 1000, 0)[1]
    const [events] = feed(vad, SPEECH, 2500, t)
    const end = events.find((e) => e.type === 'end')
    expect(end).toMatchObject({ reason: 'max' })
    expect(end && end.type === 'end' && end.durationMs).toBeGreaterThanOrEqual(2000)
  })

  it('thresholds are configurable', () => {
    const strict = createEnergyVad({ minSpeechDb: -20 })
    const t = feed(strict, QUIET, 1000, 0)[1]
    expect(feed(strict, SPEECH, 600, t)[0]).toEqual([]) // -26 dBFS is below -20
  })
})

// ---------------------------------------------------------------- identity

describe('voice identity', () => {
  it('client_id is random, persisted locally and reused', () => {
    localStorage.clear()
    const first = getClientId()
    expect(first).toMatch(/^[A-Za-z0-9-]{8,64}$/)
    expect(localStorage.getItem('lyra.clientId')).toBe(first)
    expect(getClientId()).toBe(first)
    localStorage.setItem('lyra.clientId', 'not valid!')
    expect(getClientId()).not.toBe('not valid!')
  })

  it('ids are unique', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newVoiceId()))
    expect(ids.size).toBe(50)
  })

  it('a new mic session creates a new voice_session_id; every utterance gets its own voice_turn_id', async () => {
    const a = makeConversation()
    await a.utter()
    await a.utter()
    const b = makeConversation({ newId: newVoiceId })
    expect(a.conversation.sessionId).not.toBe(b.conversation.sessionId)
    expect(a.heard).toHaveLength(2)
    expect(a.heard.every((ids) => ids.voice_session_id === a.conversation.sessionId)).toBe(true)
    expect(a.heard[0].voice_turn_id).not.toBe(a.heard[1].voice_turn_id)
    expect(a.heard.every((ids) => ids.client_id === 'client-aaaaaaaa')).toBe(true)
  })
})

// ---------------------------------------------------------------- state machine

describe('voice conversation', () => {
  it('listening -> thinking -> speaking -> listening, through the chat path', async () => {
    const h = makeConversation()
    await h.utter()
    expect(h.states).toEqual(['listening', 'thinking', 'speaking', 'listening'])
    expect(h.deps.converse).toHaveBeenCalledWith('che ore sono?')
    expect(h.spoken.map((s) => s.text)).toEqual(['Sono le dieci.', 'Buona giornata!'])
    expect(h.played).toHaveLength(2)
    expect(h.recorders[0]).toMatchObject({ started: true, stopped: true })
  })

  it('stays deaf while Lyra speaks and for a short cooldown after', async () => {
    const h = makeConversation({ cooldownMs: 400 })
    await h.utter()
    const transcribe = h.deps.transcribe as ReturnType<typeof vi.fn>
    // Lyra's echo right after speaking: ignored
    for (let now = h.t.now; now < h.t.now + 300; now += FRAME) h.conversation.frame(SPEECH, now)
    expect(h.recorders).toHaveLength(1)
    expect(transcribe).toHaveBeenCalledTimes(1)
  })

  it('stopping during thinking never speaks the late answer', async () => {
    const reply = deferred<ConverseResult>()
    const h = makeConversation({ converse: vi.fn(() => reply.promise) })
    await h.utter()
    expect(h.states.at(-1)).toBe('thinking')
    h.conversation.stop()
    reply.resolve({ ok: true, reply: 'Troppo tardi.' })
    await flush()
    expect(h.deps.speak).not.toHaveBeenCalled()
    expect(h.played).toHaveLength(0)
    expect(h.states.at(-1)).toBe('thinking') // the owner shows off; nothing else is emitted
  })

  it('stopping while speaking cuts playback and plays nothing more', async () => {
    const play = deferred<boolean>()
    const h = makeConversation()
    ;(h.deps.player.play as ReturnType<typeof vi.fn>).mockImplementationOnce(() => play.promise)
    await h.utter()
    expect(h.states.at(-1)).toBe('speaking')
    h.conversation.stop()
    expect(h.deps.player.stop).toHaveBeenCalled()
    play.resolve(false)
    await flush()
    expect(h.spoken.length).toBeLessThanOrEqual(2)
    expect(h.deps.player.play).toHaveBeenCalledTimes(1)
  })

  it('a stale transcription for a stopped session is ignored', async () => {
    const text = deferred<{ ids: VoiceIds; text: string }>()
    const h = makeConversation({ transcribe: vi.fn(() => text.promise) })
    await h.utter()
    const ids = (h.deps.transcribe as ReturnType<typeof vi.fn>).mock.calls[0][1] as VoiceIds
    h.conversation.stop()
    text.resolve({ ids, text: 'ciao' })
    await flush()
    expect(h.deps.converse).not.toHaveBeenCalled()
  })

  it('an old turn cannot hijack a new session (shared player)', async () => {
    const late = deferred<{ ids: VoiceIds; audio: ArrayBuffer }>()
    const first = makeConversation({ speak: vi.fn(() => late.promise) })
    await first.utter()
    const oldIds = (first.deps.speak as ReturnType<typeof vi.fn>).mock.calls[0][1] as VoiceIds
    first.conversation.stop()
    // the user starts a fresh conversation on the same device and player
    const second = makeConversation({ player: first.deps.player, newId: newVoiceId })
    late.resolve({ ids: oldIds, audio: new ArrayBuffer(8) })
    await flush()
    expect(first.deps.player.play).not.toHaveBeenCalled()
    expect(second.states).toEqual(['listening'])
  })

  it('an answer addressed to another client is never played here', async () => {
    // client B receives audio whose ids belong to client A (misrouted): dropped
    const b = makeConversation(
      {
        speak: vi.fn(async (_text: string, ids: VoiceIds) => ({
          ids: { ...ids, client_id: 'client-aaaaaaaa' },
          audio: new ArrayBuffer(8),
        })),
      },
      'client-bbbbbbbb',
    )
    await b.utter()
    expect(b.played).toHaveLength(0)
    expect(b.heard[0].client_id).toBe('client-bbbbbbbb')
  })

  it('two devices speaking at once each get only their own answer', async () => {
    const a = makeConversation({}, 'client-aaaaaaaa')
    const b = makeConversation({}, 'client-bbbbbbbb')
    a.speakFrames() // both turns in flight at the same time
    b.speakFrames()
    await flush()
    expect(a.spoken.every((s) => s.ids.client_id === 'client-aaaaaaaa')).toBe(true)
    expect(b.spoken.every((s) => s.ids.client_id === 'client-bbbbbbbb')).toBe(true)
    expect(a.played).toHaveLength(2)
    expect(b.played).toHaveLength(2)
  })

  it('empty utterances and silence go back to listening without asking Lyra', async () => {
    const empty = makeConversation({ transcribe: vi.fn(async (_a: Blob, ids: VoiceIds) => ({ ids, text: '  ' })) })
    await empty.utter()
    expect(empty.states).toEqual(['listening', 'thinking', 'listening'])
    expect(empty.deps.converse).not.toHaveBeenCalled()

    const tiny = makeConversation({
      createRecorder: () => ({
        mimeType: 'audio/webm',
        start: () => undefined,
        stop: async () => new Blob([new Uint8Array(10)]),
        cancel: () => undefined,
      }),
    })
    await tiny.utter()
    expect(tiny.deps.transcribe).not.toHaveBeenCalled()
    expect(tiny.states.at(-1)).toBe('listening')
  })

  it.each([
    ['STT failure', { transcribe: vi.fn(async () => Promise.reject(new Error('503'))) }, /trascrizione/],
    ['Lyra Core failure', { converse: vi.fn(async () => ({ ok: false, reply: null, error: 'Lyra non raggiungibile' })) }, /raggiungibile/],
    ['TTS failure', { speak: vi.fn(async () => Promise.reject(new Error('502'))) }, /Voce di Lyra/],
  ])('%s shows an error, then the conversation listens again', async (_name, override, message) => {
    const h = makeConversation(override as Partial<ConversationDeps>)
    await h.utter()
    expect(h.states.at(-1)).toBe('error')
    expect(h.errors.at(-1)).toMatch(message)
    h.timers.at(-1)?.()
    expect(h.states.at(-1)).toBe('listening')
    // and it still works: the next utterance is heard
    ;(h.deps.transcribe as ReturnType<typeof vi.fn>).mockImplementation(async (_a: Blob, ids: VoiceIds) => ({ ids, text: 'di nuovo' }))
    ;(h.deps.converse as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: true, reply: 'Ok.' }))
    ;(h.deps.speak as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, ids: VoiceIds) => ({ ids, audio: new ArrayBuffer(8) }))
    await h.utter()
    expect(h.states.slice(-3)).toEqual(['thinking', 'speaking', 'listening'])
  })

  it('audio suspended by the system for too long ends the session with a reason', () => {
    const h = makeConversation({ suspendedLimitMs: 3000 })
    h.conversation.frame(QUIET, 0, false)
    h.conversation.frame(QUIET, 2000, false)
    expect(h.fatal).toEqual([])
    h.conversation.frame(QUIET, 3100, false)
    expect(h.fatal[0]).toMatch(/sospeso/)
  })

  it('no recorder support is reported, not ignored', async () => {
    const h = makeConversation({ createRecorder: () => null })
    await h.utter()
    expect(h.fatal[0]).toMatch(/registrare/)
  })

  it('a noise that the VAD rejects discards its recorder', () => {
    const h = makeConversation()
    for (let now = 0; now < 1000; now += FRAME) h.conversation.frame(QUIET, now)
    for (let now = 1000; now < 1080; now += FRAME) h.conversation.frame(SPEECH, now)
    for (let now = 1080; now < 1500; now += FRAME) h.conversation.frame(QUIET, now)
    expect(h.recorders).toHaveLength(1)
    expect(h.recorders[0]).toMatchObject({ started: true, cancelled: true, stopped: false })
    expect(h.deps.transcribe).not.toHaveBeenCalled()
  })

  it('repeated turns leave no recorder open', async () => {
    const h = makeConversation()
    for (let i = 0; i < 5; i += 1) await h.utter()
    expect(h.recorders).toHaveLength(5)
    expect(h.recorders.every((r) => r.stopped || r.cancelled)).toBe(true)
    h.conversation.stop()
    expect(h.deps.player.stop).toHaveBeenCalled()
  })

  it('barge-in hook (Phase 3): interrupt stops speech and listens again', async () => {
    const play = deferred<boolean>()
    const h = makeConversation()
    ;(h.deps.player.play as ReturnType<typeof vi.fn>).mockImplementationOnce(() => play.promise)
    await h.utter()
    h.conversation.interrupt()
    expect(h.states.slice(-2)).toEqual(['interrupted', 'listening'])
    play.resolve(false)
    await flush()
    expect(h.deps.player.play).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------- recorder

class FakeMediaRecorder extends EventTarget {
  static supported = ['audio/mp4']
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported(type: string) {
    return FakeMediaRecorder.supported.includes(type)
  }
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    super()
    this.mimeType = options?.mimeType ?? 'audio/mp4'
    FakeMediaRecorder.instances.push(this)
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    const event = new Event('dataavailable') as Event & { data: Blob }
    event.data = new Blob([new Uint8Array(3000)], { type: this.mimeType })
    this.dispatchEvent(event)
    this.dispatchEvent(new Event('stop'))
  }
}

describe('utterance recorder', () => {
  it('feature-detects the container instead of assuming one', () => {
    vi.stubGlobal('MediaRecorder', undefined)
    expect(pickRecorderMimeType()).toBeNull()
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    expect(pickRecorderMimeType()).toBe('audio/mp4')
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus', 'audio/mp4']
    expect(pickRecorderMimeType()).toBe('audio/webm;codecs=opus')
    FakeMediaRecorder.supported = []
    expect(pickRecorderMimeType()).toBe('')
    FakeMediaRecorder.supported = ['audio/mp4']
  })

  it('starts and stops cleanly, and cancel discards the audio', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    FakeMediaRecorder.instances = []
    const stream = {} as MediaStream
    const recorder = createUtteranceRecorder(stream, 'audio/mp4')
    recorder.start()
    const blob = await recorder.stop()
    expect(blob?.type).toBe('audio/mp4')
    expect(blob?.size).toBe(3000)

    const dropped = createUtteranceRecorder(stream, 'audio/mp4')
    dropped.start()
    dropped.cancel()
    expect(FakeMediaRecorder.instances.every((r) => r.state === 'inactive')).toBe(true)
    expect(await dropped.stop()).toBeNull()
  })
})

// ---------------------------------------------------------------- text + chat

describe('spoken text', () => {
  it('drops Markdown and splits into short sentences', () => {
    const text = toSpeech('## Titolo\n\n- **Primo** punto con [link](https://x.y).\n- Secondo `codice`!\n\n```js\nx()\n```')
    expect(text).not.toMatch(/[#*`[\]]|https/)
    expect(chunkSpeech(text)).toEqual(['Titolo', 'Primo punto con link.', 'Secondo codice!'])
    const long = chunkSpeech(`${'parola '.repeat(80)}fine.`, 100)
    expect(long.every((c) => c.length <= 100)).toBe(true)
  })
})

describe('shared conversation path', () => {
  it('a spoken turn is a normal Chat turn, and never overlaps another request', async () => {
    const reply = deferred<Response>()
    const fetchMock = vi.fn(() => reply.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useChat())
    let first: Promise<ConverseResult> = Promise.resolve({ ok: false, reply: null })
    act(() => {
      first = result.current.converse('che ore sono?')
    })
    let second: ConverseResult = { ok: true, reply: null }
    await act(async () => {
      second = await result.current.converse('altro')
    })
    expect(second).toMatchObject({ ok: false, error: /già lavorando/ })
    await act(async () => {
      reply.resolve(
        new Response(JSON.stringify({ content: 'Le dieci.', pack: 'chat', turns: 1, complete: true, tool_results: [], metadata: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      await first
    })
    expect(await first).toEqual({ ok: true, reply: 'Le dieci.' })
    expect(result.current.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'che ore sono?'],
      ['lyra', 'Le dieci.'],
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('/api/chat')
  })
})
