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

describe('voice states for the orb (later phases)', () => {
  it('declares every voice state; real work always wins over the voice', () => {
    expect(VOICE_STATES).toEqual(['off', 'listening', 'thinking', 'speaking', 'interrupted', 'error'])
    expect(orbStateWithVoice('idle', 'off')).toBe('idle')
    expect(orbStateWithVoice('idle', 'listening')).toBe('listening')
    expect(orbStateWithVoice('idle', 'speaking')).toBe('speaking')
    expect(orbStateWithVoice('thinking', 'listening')).toBe('thinking')
    expect(orbStateWithVoice('offline', 'listening')).toBe('offline')
    expect(orbStateWithVoice('idle', 'error')).toBe('idle')
  })
})
