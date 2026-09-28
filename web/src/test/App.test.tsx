import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { ChatResponse } from '../types/api'
import { fakeSocket, FakeSocket, json, mockFetch, STATUS } from './fakes'

const REPLY: ChatResponse = {
  content: '17 × 23 = **391**',
  pack: 'general',
  turns: 2,
  complete: true,
  tool_results: [{ tool_name: 'calculator', content: '391.0', success: true }],
  metadata: { pack: 'general', tools: ['calculator'] },
}

const NOTE = {
  path: 'progetti/crm.md',
  content: '---\ntags: [crm]\n---\n# Progetto CRM\n\nUn **CRM leggero**. Vedi [[collaudo-lyra]].',
}

function setup(routes: Parameters<typeof mockFetch>[0] = {}) {
  const fetchMock = mockFetch({ '/api/status': () => json(STATUS), ...routes })
  const socket = fakeSocket()
  const user = userEvent.setup()
  const utils = render(<App live={{ socket, pollMs: 60000 }} />)
  const connect = () => act(() => FakeSocket.latest().open())
  const emit = (event: Parameters<FakeSocket['emit']>[0]) => act(() => FakeSocket.latest().emit(event))
  const orbState = () => document.querySelector('.orb-layer')?.getAttribute('data-orb-state')
  const orbPulse = () => document.querySelector('.orb-layer')?.getAttribute('data-orb-pulse')
  const nav = (name: string) => user.click(within(screen.getByRole('navigation')).getByRole('button', { name }))
  return { ...utils, fetchMock, socket, user, connect, emit, orbState, orbPulse, nav }
}

describe('Home', () => {
  it('is clean: orb, nav and the status card only', async () => {
    const { orbState } = setup()
    expect(document.querySelector('.orb-layer')).toBeInTheDocument()
    expect(orbState()).toBe('offline') // until /ws connects
    const nav = screen.getByRole('navigation')
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Home', 'Chat', 'Brain', 'Activity'])
    expect(within(nav).getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
    // No composer, no conversation, no hero texts.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Come posso aiutarti?')).not.toBeInTheDocument()
    expect(screen.queryByText(/come posso aiutarti/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/secondo cervello/i)).not.toBeInTheDocument()
    // Wide screens show the status card open; the reference's state board is not part of the UI.
    expect(screen.queryByText(/stati principali/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dettagli stato/i })).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('Status', () => {
  it('shows the reference status card on wide screens', async () => {
    const { user, connect } = setup()
    connect()
    const head = await screen.findByRole('button', { name: /Lyra attiva\. Dettagli stato/ })
    expect(head).toHaveAttribute('aria-expanded', 'true')
    const panel = screen.getByRole('region', { name: 'Stato di Lyra' })
    await waitFor(() => expect(within(panel).getByText('MiniCPM 2B (Ollama)')).toBeInTheDocument())
    expect(within(panel).getByText('Browser: Chromium')).toBeInTheDocument()
    expect(within(panel).getByText('Memoria: attiva')).toBeInTheDocument()
    expect(within(panel).getByText('Knowledge: attivo')).toBeInTheDocument()
    expect(head).toHaveAttribute('title', expect.stringContaining('openbmb/minicpm5-2b:q8_0'))
    // An outside tap does not close it on wide screens; the chevron and Esc do.
    fireEvent.pointerDown(document.body)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    await user.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'false')
    await user.click(head)
    await user.keyboard('{Escape}')
    expect(head).toHaveAttribute('aria-expanded', 'false')
  })

  it('is just the status dot on phones: tap opens, outside tap closes', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    const { user } = setup()
    const head = screen.getByRole('button', { name: /dettagli stato/i })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    // Collapsed: only the dot, no visible text (the status is in the accessible name).
    expect(head.textContent).toBe('')
    expect(head.querySelector('.status-dot')).not.toBeNull()
    await user.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(head.textContent).not.toBe('')
    fireEvent.pointerDown(document.body)
    expect(head).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows a sober offline state when Lyra is unreachable', async () => {
    mockFetch({})
    const socket = fakeSocket()
    render(<App live={{ socket, pollMs: 60000 }} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Lyra non raggiungibile/ })).toBeInTheDocument(),
    )
    expect(document.querySelector('.home-caption')).toHaveTextContent('Lyra non raggiungibile')
    expect(document.querySelector('.status')).toHaveAttribute('data-tone', 'offline')
  })
})

describe('Chat', () => {
  it('shows the composer only in Chat and keeps the conversation across tabs', async () => {
    const { user, nav, fetchMock, connect } = setup({ '/api/chat': () => json(REPLY) })
    connect()
    await nav('Chat')
    const input = screen.getByPlaceholderText('Come posso aiutarti?')
    expect(input).toBeVisible()
    await user.type(input, 'Quanto fa 17*23?{Enter}')
    await waitFor(() => expect(screen.getByText('391')).toBeInTheDocument())
    expect(screen.getByText('calculator ✓')).toBeInTheDocument()
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/chat')!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ message: 'Quanto fa 17*23?', pack: 'auto' })

    await nav('Home')
    expect(screen.queryByPlaceholderText('Come posso aiutarti?')).not.toBeInTheDocument()
    expect(screen.queryByText('Quanto fa 17*23?')).not.toBeInTheDocument()
    await nav('Chat')
    expect(screen.getByText('Quanto fa 17*23?')).toBeInTheDocument() // context preserved
    expect(screen.getByText('391')).toBeInTheDocument()
  })

  it('uses the pack shortcuts and the + menu', async () => {
    const { user, nav, fetchMock } = setup({ '/api/chat': () => json({ ...REPLY, pack: 'knowledge' }) })
    await nav('Chat')
    await user.click(screen.getByRole('button', { name: /cerca nelle note/i }))
    expect(screen.getByRole('button', { name: /Pack Knowledge/ })).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Come posso aiutarti?'), 'CRM{Enter}')
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat')).toBe(true))
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/chat')!
    expect(JSON.parse(String(call[1]?.body)).pack).toBe('knowledge')
    await user.click(screen.getByRole('button', { name: /scegli il gruppo/i }))
    await user.click(screen.getByRole('menuitemradio', { name: /Auto/ }))
    expect(screen.queryByRole('button', { name: /Pack Knowledge/ })).not.toBeInTheDocument()
  })

  it('reports a busy Lyra and keeps the draft', async () => {
    const { user, nav } = setup({ '/api/chat': () => json({ detail: 'busy' }, 409) })
    await nav('Chat')
    const input = screen.getByPlaceholderText('Come posso aiutarti?')
    await user.type(input, 'ciao{Enter}')
    await waitFor(() => expect(screen.getByText('Lyra sta già lavorando a una richiesta')).toBeInTheDocument())
    expect(input).toHaveValue('ciao')
  })
})

describe('Brain', () => {
  const NOTES = {
    notes: [
      { path: 'appunti.md', title: 'Appunti' },
      { path: 'collaudo-lyra.md', title: 'Collaudo Lyra' },
      { path: 'progetti/crm.md', title: 'Progetto CRM' },
    ],
    skipped: 0,
  }

  it('lists every note as soon as it opens, without searching', async () => {
    const { nav, fetchMock } = setup({ '/api/knowledge/notes': () => json(NOTES) })
    await nav('Brain')
    const list = await screen.findByRole('list', { name: 'Note del vault' })
    expect(within(list).getAllByRole('button').map((b) => b.querySelector('.brain-result-title')?.textContent)).toEqual([
      'Appunti',
      'Collaudo Lyra',
      'Progetto CRM',
    ])
    expect(screen.getByText('3 note')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Cerca nelle note…')).toHaveValue('')
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/knowledge/search'))).toBe(false)
  })

  it('filters by title/path at once and merges full-text hits', async () => {
    const { user, nav } = setup({
      '/api/knowledge/notes': () => json(NOTES),
      '/api/knowledge/search': () =>
        json({ results: [{ path: 'collaudo-lyra.md', excerpt: '# Collaudo Lyra Il colore è **ametista**' }], skipped: 0 }),
    })
    await nav('Brain')
    await screen.findByRole('list', { name: 'Note del vault' })
    const input = screen.getByPlaceholderText('Cerca nelle note…')
    await user.type(input, 'crm')
    expect(screen.getAllByRole('button', { name: /Progetto CRM/ })).toHaveLength(1) // title match, instant
    expect(screen.queryByRole('button', { name: /Appunti/ })).not.toBeInTheDocument()
    await user.clear(input)
    await user.type(input, 'ametista')
    // Not in any title: found by the vault full-text search, with a clean excerpt.
    expect(await screen.findByText('Collaudo Lyra Il colore è ametista')).toBeInTheDocument()
  })

  it('opens a note read-only and follows wikilinks as searches', async () => {
    const { user, nav } = setup({
      '/api/knowledge/notes': () => json(NOTES),
      '/api/knowledge/search': () => json({ results: [], skipped: 0 }),
      '/api/knowledge/note': () => json(NOTE),
    })
    await nav('Brain')
    await user.click(await screen.findByRole('button', { name: /Progetto CRM/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Progetto CRM' })).toBeInTheDocument()
    expect(screen.getByText('CRM leggero').tagName).toBe('STRONG')
    expect(screen.queryByText(/tags:/)).not.toBeInTheDocument() // frontmatter hidden
    await user.click(screen.getByRole('button', { name: 'collaudo-lyra' }))
    expect(screen.getByPlaceholderText('Cerca nelle note…')).toHaveValue('collaudo-lyra')
  })

  it('explains an empty vault and a search without matches', async () => {
    const { user, nav } = setup({
      '/api/knowledge/notes': () => json({ notes: [], skipped: 0 }),
      '/api/knowledge/search': () => json({ results: [], skipped: 0 }),
    })
    await nav('Brain')
    expect(await screen.findByText('Il vault non contiene ancora note.')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Cerca nelle note…'), 'zzz')
    expect(await screen.findByText('Nessuna nota trovata per «zzz».')).toBeInTheDocument()
  })

  it('says so when knowledge is off on Lyra', async () => {
    const { nav } = setup({ '/api/knowledge/notes': () => json({ detail: 'Knowledge vault is disabled' }, 404) })
    await nav('Brain')
    expect(await screen.findByText('Knowledge non è attivo su Lyra')).toBeInTheDocument()
  })

  it('keeps search usable against an older Lyra Core without the list endpoint', async () => {
    const { user, nav } = setup({
      '/api/knowledge/notes': () => json({ detail: 'Not Found' }, 404),
      '/api/knowledge/search': () => json({ results: [{ path: 'progetti/crm.md', excerpt: 'CRM leggero' }], skipped: 0 }),
    })
    await nav('Brain')
    expect(await screen.findByText(/aggiorna Lyra Core sul server/)).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Cerca nelle note…'), 'crm')
    expect(await screen.findByRole('button', { name: /CRM leggero/ })).toBeInTheDocument()
  })
})

describe('Live runtime', () => {
  it('says what Lyra is doing under the orb, with the real tool name', async () => {
    const { connect, emit } = setup()
    connect()
    const caption = () => document.querySelector('.home-caption')?.textContent
    expect(caption()).toBe('')
    emit({ type: 'state', state: 'thinking' })
    expect(caption()).toBe('Sto pensando…')
    emit({ type: 'tool_started', tool: 'calculator' })
    emit({ type: 'state', state: 'using_tool' })
    expect(caption()).toBe('Uso la calcolatrice…')
    emit({ type: 'state', state: 'idle' })
    await waitFor(() => expect(caption()).toBe(''), { timeout: 3000 })
  })

  it('drives the orb and the Activity timeline from real /ws events', async () => {
    const { nav, connect, emit, orbState, orbPulse } = setup()
    connect()
    expect(orbState()).toBe('idle')
    emit({ type: 'state', state: 'thinking' })
    expect(orbState()).toBe('thinking')
    emit({ type: 'state', state: 'using_tool' })
    emit({ type: 'tool_started', tool: 'calculator' })
    expect(orbState()).toBe('using_tool')
    expect(orbPulse()).toBe('tool_started') // outward pulse
    emit({ type: 'tool_finished', tool: 'calculator', success: true })
    emit({ type: 'state', state: 'thinking' })
    // A fast tool stays visible, and the inward pulse follows the outward one.
    expect(orbState()).toBe('using_tool')
    await waitFor(() => expect(orbPulse()).toBe('tool_finished'))
    emit({ type: 'response', content: '391' })
    expect(orbPulse()).toBe('response')
    emit({ type: 'state', state: 'idle' })
    expect(orbState()).toBe('response')
    await waitFor(() => expect(orbState()).toBe('idle'), { timeout: 3000 })

    expect(document.querySelector('.nav-badge')).toBeInTheDocument()
    await nav('Activity')
    const timeline = document.querySelector('.timeline') as HTMLElement
    expect(within(timeline).getAllByRole('listitem').map((li) => li.querySelector('.timeline-title')?.textContent)).toEqual([
      'Connessa',
      'Thinking',
      'Using toolcalculator',
      'Tool completedcalculator',
      'Thinking',
      'Response',
    ])
    expect(document.querySelector('.nav-badge')).not.toBeInTheDocument()
  })

  it('shows error states discreetly and survives a dropped socket', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { connect, emit, orbState, nav } = setup()
      connect()
      emit({ type: 'error', message: 'Ollama unreachable' })
      emit({ type: 'state', state: 'error' })
      expect(orbState()).toBe('error')
      emit({ type: 'state', state: 'idle' })
      act(() => FakeSocket.latest().drop())
      expect(orbState()).toBe('offline')
      expect(FakeSocket.instances).toHaveLength(1)
      await act(async () => {
        vi.advanceTimersByTime(1100)
      })
      expect(FakeSocket.instances).toHaveLength(2) // reconnecting on its own
      await nav('Brain') // UI stays usable while offline
      expect(screen.getByPlaceholderText('Cerca nelle note…')).toBeInTheDocument()
      connect()
      expect(orbState()).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Mobile', () => {
  it('navigates on a phone viewport and opens notes full screen with back', async () => {
    Object.assign(window, { innerWidth: 390, innerHeight: 844 })
    window.dispatchEvent(new Event('resize'))
    const { user, nav } = setup({
      '/api/knowledge/notes': () => json({ notes: [{ path: NOTE.path, title: 'Progetto CRM' }], skipped: 0 }),
      '/api/knowledge/note': () => json(NOTE),
    })
    await nav('Chat')
    expect(screen.getByPlaceholderText('Come posso aiutarti?')).toBeInTheDocument()
    await nav('Brain')
    const brain = screen.getByRole('region', { name: 'Brain' })
    expect(brain).toHaveAttribute('data-note-open', 'false')
    // The list is there immediately: tap a note, read it full screen, go back.
    await user.click(await screen.findByRole('button', { name: /Progetto CRM/ }))
    await screen.findByRole('heading', { level: 1, name: 'Progetto CRM' })
    expect(brain).toHaveAttribute('data-note-open', 'true')
    await user.click(screen.getByRole('button', { name: 'Note' }))
    expect(brain).toHaveAttribute('data-note-open', 'false')
    await nav('Home')
    expect(screen.queryByRole('region', { name: 'Brain' })).not.toBeInTheDocument()
    Object.assign(window, { innerWidth: 1024, innerHeight: 768 })
  })
})

describe('Voice: Home and Chat share one session', () => {
  function fakeMic({ deny = false } = {}) {
    const tracks: { stop: ReturnType<typeof vi.fn>; readyState: string; addEventListener: () => void }[] = []
    const getUserMedia = vi.fn(async () => {
      if (deny) throw new DOMException('denied', 'NotAllowedError')
      const track = {
        readyState: 'live',
        stop: vi.fn(() => {
          track.readyState = 'ended'
        }),
        addEventListener: () => undefined,
      }
      tracks.push(track)
      return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
    })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    vi.stubGlobal('AudioContext', undefined)
    return { tracks, getUserMedia }
  }
  const voiceState = () => document.querySelector('.app')?.getAttribute('data-voice')
  const micButton = () => screen.getByRole('button', { name: /microfono/i })
  const routes = { '/api/knowledge/notes': () => json({ notes: [], skipped: 0 }) }

  it('Home mic OFF -> LISTENING, and the orb follows the voice when idle', async () => {
    const { getUserMedia } = fakeMic()
    const { user, connect, orbState } = setup(routes)
    connect()
    expect(orbState()).toBe('idle')
    const mic = within(screen.getByRole('region', { name: 'Home' })).getByRole('button', {
      name: 'Attiva il microfono',
    })
    await user.click(mic)
    expect(voiceState()).toBe('listening')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(orbState()).toBe('listening')
    expect(document.querySelector('.home-caption')).toHaveTextContent('Ti ascolto')
  })

  it('Home -> Chat -> Home while LISTENING keeps the same live microphone', async () => {
    const { tracks, getUserMedia } = fakeMic()
    const { user, nav } = setup(routes)
    await user.click(micButton())
    await nav('Chat')
    expect(voiceState()).toBe('listening')
    expect(micButton()).toHaveAttribute('aria-pressed', 'true') // Chat control shows the same session
    await nav('Home')
    expect(voiceState()).toBe('listening')
    expect(micButton()).toHaveAttribute('aria-pressed', 'true')
    expect(getUserMedia).toHaveBeenCalledTimes(1) // one stream, never reopened
    expect(tracks[0].stop).not.toHaveBeenCalled()
  })

  it('Chat -> Home while LISTENING keeps the mic; stopping in Home is seen in Chat', async () => {
    const { tracks } = fakeMic()
    const { user, nav } = setup(routes)
    await nav('Chat')
    await user.click(micButton())
    await nav('Home')
    expect(voiceState()).toBe('listening')
    expect(tracks[0].stop).not.toHaveBeenCalled()
    await user.click(micButton()) // stop from Home
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    await nav('Chat')
    expect(micButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it.each([
    ['Home', 'Brain'],
    ['Home', 'Activity'],
    ['Chat', 'Brain'],
    ['Chat', 'Activity'],
  ])('%s -> %s stops and releases the mic; returning never restarts it', async (from, to) => {
    const { tracks, getUserMedia } = fakeMic()
    const { user, nav } = setup(routes)
    if (from === 'Chat') await nav('Chat')
    await user.click(micButton())
    await nav(to)
    expect(voiceState()).toBe('off')
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(tracks[0].readyState).toBe('ended')
    await nav('Home')
    expect(voiceState()).toBe('off')
    await nav('Chat')
    expect(voiceState()).toBe('off')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('backgrounding releases the mic in Home', async () => {
    const { tracks } = fakeMic()
    const { user } = setup(routes)
    await user.click(micButton())
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    visibility.mockRestore()
    expect(voiceState()).toBe('off')
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
  })

  it('a microphone error reaches the orb and the caption when Lyra is idle', async () => {
    fakeMic({ deny: true })
    const { user, connect, orbState } = setup(routes)
    connect()
    await user.click(micButton())
    expect(voiceState()).toBe('error')
    expect(orbState()).toBe('error')
    expect(document.querySelector('.home-caption')).toHaveTextContent(/negato/)
  })

  it('runtime work has priority over the voice state', async () => {
    fakeMic()
    const { user, connect, emit, orbState } = setup(routes)
    connect()
    await user.click(micButton())
    expect(orbState()).toBe('listening')
    emit({ type: 'state', state: 'thinking' })
    expect(orbState()).toBe('thinking')
    expect(document.querySelector('.home-caption')).toHaveTextContent('Sto pensando')
  })
})
