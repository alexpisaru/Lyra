import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MicButton } from '../components/MicButton'
import { orbStateWithVoice } from '../lib/orbState'
import { createLevelMeter } from '../voice/levelMeter'
import { MIC_CONSTRAINTS, VOICE_STATES } from '../voice/types'
import { useVoiceSession } from '../voice/useVoiceSession'

// ---------------------------------------------------------------- fakes

class FakeTrack {
  readyState: 'live' | 'ended' = 'live'
  kind = 'audio'
  stop = vi.fn(() => {
    this.readyState = 'ended'
  })
  private listeners: Record<string, (() => void)[]> = {}
  addEventListener(type: string, fn: () => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  fire(type: string) {
    this.readyState = 'ended'
    this.listeners[type]?.forEach((fn) => fn())
  }
}

class FakeStream {
  tracks = [new FakeTrack()]
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks
  }
}

function fakeAudio() {
  const contexts: FakeContext[] = []
  class FakeContext {
    state = 'running'
    source = { connect: vi.fn(), disconnect: vi.fn() }
    analyser = { fftSize: 0, smoothingTimeConstant: 0, disconnect: vi.fn(), getFloatTimeDomainData: vi.fn() }
    close = vi.fn(async () => {
      this.state = 'closed'
    })
    resume = vi.fn(async () => undefined)
    constructor() {
      contexts.push(this)
    }
    createMediaStreamSource() {
      return this.source
    }
    createAnalyser() {
      return this.analyser
    }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  return contexts
}

function fakeMicrophone(result: 'grant' | 'deny' | Promise<never> = 'grant') {
  const streams: FakeStream[] = []
  const getUserMedia = vi.fn(async (_constraints?: MediaStreamConstraints) => {
    if (result === 'deny') throw new DOMException('denied', 'NotAllowedError')
    if (result instanceof Promise) return result
    const stream = new FakeStream()
    streams.push(stream)
    return stream as unknown as MediaStream
  })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  return { streams, getUserMedia }
}

function allTracks(streams: FakeStream[]) {
  return streams.flatMap((stream) => stream.tracks)
}

// ---------------------------------------------------------------- session

describe('useVoiceSession', () => {
  it('starts OFF and never opens the microphone by itself', () => {
    const { getUserMedia } = fakeMicrophone()
    const { result } = renderHook(() => useVoiceSession())
    expect(result.current.voiceState).toBe('off')
    expect(result.current.hasLiveTrack).toBe(false)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('OFF -> LISTENING after a successful getUserMedia, with the requested constraints', async () => {
    const contexts = fakeAudio()
    const { getUserMedia } = fakeMicrophone()
    const { result } = renderHook(() => useVoiceSession())
    await act(() => result.current.startListening())
    expect(getUserMedia).toHaveBeenCalledWith(MIC_CONSTRAINTS)
    expect(MIC_CONSTRAINTS.audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })
    expect(result.current.voiceState).toBe('listening')
    expect(result.current.micPermission).toBe('granted')
    expect(result.current.hasLiveTrack).toBe(true)
    expect(contexts).toHaveLength(1)
    // analysed only: never connected to the speakers
    expect(contexts[0].source.connect).toHaveBeenCalledWith(contexts[0].analyser)
  })

  it('permission denied -> ERROR, nothing left open', async () => {
    const contexts = fakeAudio()
    fakeMicrophone('deny')
    const { result } = renderHook(() => useVoiceSession())
    await act(() => result.current.startListening())
    expect(result.current.voiceState).toBe('error')
    expect(result.current.micPermission).toBe('denied')
    expect(result.current.error).toMatch(/negato/)
    expect(result.current.hasLiveTrack).toBe(false)
    expect(contexts[0].close).toHaveBeenCalled()
  })

  it('no microphone API (insecure origin) -> ERROR explaining HTTPS', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    const { result } = renderHook(() => useVoiceSession())
    await act(() => result.current.startListening())
    expect(result.current.voiceState).toBe('error')
    expect(result.current.micPermission).toBe('unsupported')
    expect(result.current.error).toMatch(/HTTPS/)
  })

  it('LISTENING -> OFF stops every track and closes the AudioContext', async () => {
    const contexts = fakeAudio()
    const { streams } = fakeMicrophone()
    const { result } = renderHook(() => useVoiceSession())
    await act(() => result.current.startListening())
    act(() => result.current.stopListening())
    expect(result.current.voiceState).toBe('off')
    expect(result.current.hasLiveTrack).toBe(false)
    expect(result.current.inputLevel).toBe(0)
    expect(allTracks(streams).every((track) => track.stop.mock.calls.length === 1)).toBe(true)
    expect(contexts[0].source.disconnect).toHaveBeenCalled()
    expect(contexts[0].close).toHaveBeenCalled()
  })

  it('page hidden stops the microphone', async () => {
    fakeAudio()
    const { streams } = fakeMicrophone()
    const { result } = renderHook(() => useVoiceSession())
    await act(() => result.current.startListening())
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current.voiceState).toBe('off')
    expect(streams[0].tracks[0].stop).toHaveBeenCalled()
    visibility.mockRestore()
  })

  it('pagehide stops the microphone', async () => {
    fakeAudio()
    const { streams } = fakeMicrophone()
    const { result } = renderHook(() => useVoiceSession())
    await act(() => result.current.startListening())
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(result.current.voiceState).toBe('off')
    expect(streams[0].tracks[0].stop).toHaveBeenCalled()
  })

  it('unmount stops the microphone', async () => {
    const contexts = fakeAudio()
    const { streams } = fakeMicrophone()
    const { result, unmount } = renderHook(() => useVoiceSession())
    await act(() => result.current.startListening())
    unmount()
    expect(streams[0].tracks[0].stop).toHaveBeenCalled()
    expect(contexts[0].close).toHaveBeenCalled()
  })

  it('repeated start/stop does not leak streams or AudioContexts', async () => {
    const contexts = fakeAudio()
    const { streams } = fakeMicrophone()
    const { result } = renderHook(() => useVoiceSession())
    for (let i = 0; i < 5; i += 1) {
      await act(() => result.current.startListening())
      act(() => result.current.stopListening())
    }
    // a second start without stop replaces, never stacks, the session
    await act(() => result.current.startListening())
    await act(() => result.current.startListening())
    act(() => result.current.stopListening())
    expect(streams).toHaveLength(7)
    expect(allTracks(streams).every((track) => track.readyState === 'ended')).toBe(true)
    expect(contexts).toHaveLength(7)
    expect(contexts.every((context) => context.state === 'closed')).toBe(true)
  })

  it('a stream granted after stop (slow permission prompt) is released at once', async () => {
    fakeAudio()
    let grant: (stream: MediaStream) => void = () => undefined
    const pending = new Promise<MediaStream>((resolve) => {
      grant = resolve
    })
    const getUserMedia = vi.fn(() => pending)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    const { result } = renderHook(() => useVoiceSession())
    let starting: Promise<void> = Promise.resolve()
    act(() => {
      starting = result.current.startListening()
    })
    act(() => result.current.stopListening())
    const late = new FakeStream()
    await act(async () => {
      grant(late as unknown as MediaStream)
      await starting
    })
    expect(late.tracks[0].stop).toHaveBeenCalled()
    expect(result.current.voiceState).toBe('off')
  })

  it('the OS ending the track returns to OFF', async () => {
    fakeAudio()
    const { streams } = fakeMicrophone()
    const { result } = renderHook(() => useVoiceSession())
    await act(() => result.current.startListening())
    act(() => streams[0].tracks[0].fire('ended'))
    expect(result.current.voiceState).toBe('off')
    expect(result.current.hasLiveTrack).toBe(false)
  })

  it('works without AudioContext: listening with level 0', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const { result } = renderHook(() => useVoiceSession())
    fakeMicrophone()
    await act(() => result.current.startListening())
    expect(result.current.voiceState).toBe('listening')
    expect(result.current.inputLevel).toBe(0)
    act(() => result.current.stopListening())
    expect(result.current.voiceState).toBe('off')
  })
})

describe('level meter', () => {
  it('handles a missing or failing AudioContext cleanly', () => {
    vi.stubGlobal('AudioContext', undefined)
    const meter = createLevelMeter()
    expect(meter.context).toBeNull()
    expect(() => meter.attach(new FakeStream() as unknown as MediaStream, () => undefined)).not.toThrow()
    meter.close()
    meter.close() // idempotent

    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('not allowed')
        }
      },
    )
    const failing = createLevelMeter()
    expect(failing.context).toBeNull()
    failing.close()
  })
})

// ---------------------------------------------------------------- UI

describe('MicButton', () => {
  it('toggles OFF -> LISTENING -> OFF from taps and shows the error state', async () => {
    fakeAudio()
    fakeMicrophone()
    const user = userEvent.setup()
    function Harness() {
      return <MicButton voice={useVoiceSession()} />
    }
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Attiva il microfono' })
    expect(button).toHaveAttribute('data-voice', 'off')
    await user.click(button)
    expect(button).toHaveAttribute('data-voice', 'listening')
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveAccessibleName('Disattiva il microfono')
    await user.click(button)
    expect(button).toHaveAttribute('data-voice', 'off')

    fakeMicrophone('deny')
    await user.click(button)
    expect(button).toHaveAttribute('data-voice', 'error')
    expect(button.getAttribute('aria-label')).toMatch(/negato/)
  })
})

describe('voice states for the orb', () => {
  it('declares every voice state; real work always wins over the voice', () => {
    expect(VOICE_STATES).toEqual(['off', 'listening', 'thinking', 'speaking', 'interrupted', 'error'])
    expect(orbStateWithVoice('idle', 'off')).toBe('idle')
    expect(orbStateWithVoice('idle', 'listening')).toBe('listening')
    expect(orbStateWithVoice('idle', 'speaking')).toBe('speaking')
    expect(orbStateWithVoice('thinking', 'listening')).toBe('thinking')
    expect(orbStateWithVoice('offline', 'listening')).toBe('offline')
    expect(orbStateWithVoice('idle', 'error')).toBe('error')
    expect(orbStateWithVoice('idle', 'interrupted')).toBe('interrupted')
    expect(orbStateWithVoice('using_tool', 'error')).toBe('using_tool')
  })
})

// ---------------------------------------------------------------- Phase 2 pipeline

describe('voice session with conversation (Phase 2)', () => {
  class FakeRecorder extends EventTarget {
    static isTypeSupported = (type: string) => type === 'audio/mp4'
    static live = 0
    state: 'inactive' | 'recording' = 'inactive'
    mimeType = 'audio/mp4'
    start() {
      this.state = 'recording'
      FakeRecorder.live += 1
    }
    stop() {
      if (this.state === 'inactive') return
      this.state = 'inactive'
      FakeRecorder.live -= 1
      const event = new Event('dataavailable') as Event & { data: Blob }
      event.data = new Blob([new Uint8Array(5000)], { type: 'audio/mp4' })
      this.dispatchEvent(event)
      this.dispatchEvent(new Event('stop'))
    }
  }

  function pipeline() {
    const contexts = fakeAudio()
    const { streams } = fakeMicrophone()
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    FakeRecorder.live = 0
    let tick: ((now: number) => void) | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      tick = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      tick = null
    })
    let level = 0.001
    let now = 0
    const frames = (rms: number, ms: number) => {
      level = rms
      for (const end = now + ms; now < end; now += 16) tick?.(now)
    }
    const played: ArrayBuffer[] = []
    const reply = { current: Promise.resolve({ ok: true, reply: 'Sono le dieci.' }) as Promise<{ ok: boolean; reply: string | null }> }
    const deps = {
      transcribe: vi.fn(async (_audio: Blob, ids: import('../voice/identity').VoiceIds) => ({ ids, text: 'che ore sono' })),
      speak: vi.fn(async (_text: string, ids: import('../voice/identity').VoiceIds) => ({ ids, audio: new ArrayBuffer(8) })),
      player: { play: vi.fn(async (audio: ArrayBuffer) => (played.push(audio), true)), stop: vi.fn() },
      now: () => now,
    }
    const converse = vi.fn(() => reply.current)
    const hook = renderHook(() => useVoiceSession({ converse, conversation: deps }))
    const analyser = () => contexts.at(-1)!.analyser
    const start = async () => {
      await act(() => hook.result.current.startListening())
      analyser().getFloatTimeDomainData.mockImplementation((data: Float32Array) => data.fill(level))
    }
    const utter = async () => {
      frames(0.001, 1000)
      frames(0.05, 600)
      frames(0.001, 1000)
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    }
    return { hook, contexts, streams, deps, converse, reply, played, start, utter, frames }
  }

  it('tap -> listening -> utterance -> thinking -> speaking -> listening, mic kept open', async () => {
    const p = pipeline()
    await p.start()
    expect(p.hook.result.current.voiceState).toBe('listening')
    await p.utter()
    expect(p.deps.transcribe).toHaveBeenCalledTimes(1)
    const [audio, ids] = p.deps.transcribe.mock.calls[0]
    expect(audio.type).toBe('audio/mp4')
    expect(ids.client_id).toBe(localStorage.getItem('lyra.clientId'))
    expect(p.converse).toHaveBeenCalledWith('che ore sono')
    expect(p.played).toHaveLength(1)
    expect(p.hook.result.current.voiceState).toBe('listening')
    expect(p.streams[0].tracks[0].readyState).toBe('live') // same mic for the next turn
    expect(FakeRecorder.live).toBe(0)
  })

  it('stopping during thinking releases everything and never plays the answer', async () => {
    const p = pipeline()
    let answer!: (value: { ok: boolean; reply: string | null }) => void
    p.reply.current = new Promise((resolve) => {
      answer = resolve
    })
    await p.start()
    await p.utter()
    expect(p.hook.result.current.voiceState).toBe('thinking')
    act(() => p.hook.result.current.stopListening())
    expect(p.hook.result.current.voiceState).toBe('off')
    await act(async () => answer({ ok: true, reply: 'Tardi.' }))
    expect(p.deps.speak).not.toHaveBeenCalled()
    expect(p.played).toHaveLength(0)
    expect(p.streams[0].tracks[0].stop).toHaveBeenCalled()
    expect(p.contexts[0].close).toHaveBeenCalled()
    expect(p.hook.result.current.voiceState).toBe('off')
  })

  it('backgrounding during a turn stops the mic and drops the answer', async () => {
    const p = pipeline()
    let answer!: (value: { ok: boolean; reply: string | null }) => void
    p.reply.current = new Promise((resolve) => {
      answer = resolve
    })
    await p.start()
    await p.utter()
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    await act(async () => answer({ ok: true, reply: 'Tardi.' }))
    expect(p.played).toHaveLength(0)
    expect(p.hook.result.current.voiceState).toBe('off')
  })

  it('repeated sessions and turns do not leak streams, AudioContexts or recorders', async () => {
    const p = pipeline()
    const sessions = new Set<string>()
    for (let i = 0; i < 3; i += 1) {
      await p.start()
      await p.utter()
      await p.utter()
      act(() => p.hook.result.current.stopListening())
    }
    for (const call of p.deps.transcribe.mock.calls) sessions.add(call[1].voice_session_id)
    expect(sessions.size).toBe(3) // a fresh voice_session_id per mic conversation
    expect(p.deps.transcribe).toHaveBeenCalledTimes(6)
    expect(p.streams.flatMap((s) => s.tracks).every((t) => t.readyState === 'ended')).toBe(true)
    expect(p.contexts.every((c) => c.state === 'closed')).toBe(true)
    expect(FakeRecorder.live).toBe(0)
  })
})
