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
  const nav = (name: string) => user.click(within(screen.getByRole('navigation')).getByRole('button', { name }))
  return { ...utils, fetchMock, socket, user, connect, emit, orbState, nav }
}

describe('Home', () => {
  it('is clean: orb, nav and a collapsed status only', async () => {
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
    expect(screen.getByRole('button', { name: /dettagli stato/i })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('Status', () => {
  it('loads /api/status and expands on tap, closes on outside tap and Esc', async () => {
    const { user, fetchMock } = setup()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/status', expect.anything()))
    const pill = screen.getByRole('button', { name: /dettagli stato/i })
    await user.click(pill)
    expect(pill).toHaveAttribute('aria-expanded', 'true')
    const panel = screen.getByRole('region', { name: 'Stato di Lyra' })
    await waitFor(() => expect(within(panel).getByText('openbmb/minicpm5-2b:q8_0')).toBeInTheDocument())
    expect(within(panel).getByText('Ollama')).toBeInTheDocument()
    expect(within(panel).getByText('Chromium')).toBeInTheDocument()
    expect(within(panel).getByText('0.3.0')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(pill).toHaveAttribute('aria-expanded', 'false')
    await user.click(pill)
    await user.keyboard('{Escape}')
    expect(pill).toHaveAttribute('aria-expanded', 'false')
  })

  it('expands on hover where a fine pointer can hover', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('hover'), addEventListener() {}, removeEventListener() {} }))
    const { user } = setup()
    const pill = screen.getByRole('button', { name: /dettagli stato/i })
    await user.hover(pill)
    expect(pill).toHaveAttribute('aria-expanded', 'true')
    await user.unhover(pill.parentElement!)
    expect(pill).toHaveAttribute('aria-expanded', 'false')
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
  it('searches the vault and opens a note (read-only)', async () => {
    const { user, nav, fetchMock } = setup({
      '/api/knowledge/search': () => json({ results: [{ path: NOTE.path, excerpt: '# Progetto CRM Un **CRM leggero**' }], skipped: 0 }),
      '/api/knowledge/note': () => json(NOTE),
    })
    await nav('Brain')
    await user.type(screen.getByPlaceholderText('Cerca nel tuo vault…'), 'crm')
    const result = await screen.findByRole('button', { name: /Progetto CRM Un CRM leggero/ })
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/knowledge/search?q=crm')).toBe(true)
    await user.click(result)
    expect(await screen.findByRole('heading', { level: 1, name: 'Progetto CRM' })).toBeInTheDocument()
    expect(screen.getByText('progetti/crm.md')).toBeInTheDocument()
    expect(screen.getByText('CRM leggero').tagName).toBe('STRONG')
    expect(screen.queryByText(/tags:/)).not.toBeInTheDocument() // frontmatter hidden
    expect(screen.queryByRole('textbox', { name: /modifica/i })).not.toBeInTheDocument()
    // A wikilink runs a new search inside Brain.
    await user.click(screen.getByRole('button', { name: 'collaudo-lyra' }))
    expect(screen.getByPlaceholderText('Cerca nel tuo vault…')).toHaveValue('collaudo-lyra')
  })

  it('explains an empty result and a missing note', async () => {
    const { user, nav } = setup({
      '/api/knowledge/search': () => json({ results: [], skipped: 0 }),
    })
    await nav('Brain')
    await user.type(screen.getByPlaceholderText('Cerca nel tuo vault…'), 'zzz')
    expect(await screen.findByText('Nessuna nota trovata per «zzz».')).toBeInTheDocument()
  })
})

describe('Live runtime', () => {
  it('drives the orb and the Activity timeline from real /ws events', async () => {
    const { nav, connect, emit, orbState } = setup()
    connect()
    expect(orbState()).toBe('idle')
    emit({ type: 'state', state: 'thinking' })
    expect(orbState()).toBe('thinking')
    emit({ type: 'state', state: 'using_tool' })
    emit({ type: 'tool_started', tool: 'calculator' })
    expect(orbState()).toBe('using_tool')
    emit({ type: 'tool_finished', tool: 'calculator', success: true })
    emit({ type: 'state', state: 'thinking' })
    emit({ type: 'response', content: '391' })
    emit({ type: 'state', state: 'idle' })
    expect(orbState()).toBe('response')
    await waitFor(() => expect(orbState()).toBe('idle'), { timeout: 3000 })

    expect(document.querySelector('.nav-badge')).toBeInTheDocument()
    await nav('Activity')
    const timeline = screen.getByRole('list')
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
      expect(screen.getByPlaceholderText('Cerca nel tuo vault…')).toBeInTheDocument()
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
      '/api/knowledge/search': () => json({ results: [{ path: NOTE.path, excerpt: 'CRM' }], skipped: 0 }),
      '/api/knowledge/note': () => json(NOTE),
    })
    await nav('Chat')
    expect(screen.getByPlaceholderText('Come posso aiutarti?')).toBeInTheDocument()
    await nav('Brain')
    const brain = screen.getByRole('region', { name: 'Brain' })
    expect(brain).toHaveAttribute('data-note-open', 'false')
    await user.type(screen.getByPlaceholderText('Cerca nel tuo vault…'), 'crm')
    await user.click(await screen.findByRole('button', { name: /crm/i }))
    await screen.findByRole('heading', { level: 1, name: 'Progetto CRM' })
    expect(brain).toHaveAttribute('data-note-open', 'true')
    await user.click(screen.getByRole('button', { name: 'Note' }))
    expect(brain).toHaveAttribute('data-note-open', 'false')
    await nav('Home')
    expect(screen.queryByRole('region', { name: 'Brain' })).not.toBeInTheDocument()
    Object.assign(window, { innerWidth: 1024, innerHeight: 768 })
  })
})
