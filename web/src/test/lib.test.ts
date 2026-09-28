import { describe, expect, it, vi } from 'vitest'
import { activityReducer, initialActivity, MAX_ENTRIES, type ActivityState } from '../lib/activity'
import { api, ApiError, setApiToken } from '../lib/api'
import { orbFrame } from '../lib/frames'
import { excerptText, noteTitle, prepareNote, stripFrontmatter, WIKI_PREFIX } from '../lib/notes'
import { pickQuality, QUALITY } from '../lib/orbScene'
import { ENTER_SECONDS, EXIT_SECONDS, RingMorph, SPHERE } from '../lib/ringMorph'
import { deriveOrbState, FUTURE_ORB_STATES, ORB_PARAMS, orbParams, workCaption, type OrbState } from '../lib/orbState'
import { backoffDelay, parseEvent } from '../lib/websocket'
import { prettyModel } from '../components/StatusPill'
import { standaloneGap } from '../lib/standalone'
import type { LyraEvent } from '../types/api'
import { fakeSocket, FakeSocket, json, mockFetch, STATUS } from './fakes'

describe('api client', () => {
  it('fetches and types /api/status', async () => {
    const fetchMock = mockFetch({ '/api/status': () => json(STATUS) })
    await expect(api.status()).resolves.toEqual(STATUS)
    expect(fetchMock).toHaveBeenCalledWith('/api/status', expect.objectContaining({ cache: 'no-store' }))
  })

  it('reports an unreachable backend as offline', async () => {
    mockFetch({})
    await expect(api.status()).rejects.toMatchObject({ kind: 'offline', message: 'Lyra non raggiungibile' })
  })

  it('treats a proxy 502 as offline and 409 as busy', async () => {
    mockFetch({ '/api/status': () => new Response('Bad Gateway', { status: 502 }) })
    await expect(api.status()).rejects.toMatchObject({ kind: 'offline' })
    mockFetch({ '/api/chat': () => json({ detail: 'Lyra is busy with another request; retry later' }, 409) })
    const error = await api.chat('ciao').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'busy', status: 409 })
  })

  it('posts chat as JSON with pack auto by default', async () => {
    const fetchMock = mockFetch({
      '/api/chat': () => json({ content: '391', pack: 'general', turns: 2, complete: true, tool_results: [], metadata: {} }),
    })
    await api.chat('Quanto fa 17*23?')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/chat')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ message: 'Quanto fa 17*23?', pack: 'auto' })
  })

  it('encodes knowledge queries and paths', async () => {
    const fetchMock = mockFetch({
      '/api/knowledge/search': () => json({ results: [], skipped: 0 }),
      '/api/knowledge/note': () => json({ path: 'a b.md', content: 'x' }),
    })
    await api.searchNotes('crm & co')
    await api.readNote('progetti/a b.md')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/knowledge/search?q=crm%20%26%20co')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/knowledge/note?path=progetti%2Fa%20b.md')
  })

  it('sends a bearer token only when one is configured (nothing is bundled)', async () => {
    const fetchMock = mockFetch({ '/api/status': () => json(STATUS) })
    await api.status()
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)
    setApiToken('token-token-token-123')
    await api.status()
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer token-token-token-123')
  })
})

describe('websocket client', () => {
  it('parses only known events', () => {
    expect(parseEvent('{"type":"state","state":"thinking"}')).toEqual({ type: 'state', state: 'thinking' })
    expect(parseEvent('{"type":"unknown"}')).toBeNull()
    expect(parseEvent('not json')).toBeNull()
    expect(parseEvent(new ArrayBuffer(2))).toBeNull()
  })

  it('backs off exponentially with a cap and jitter', () => {
    const mid = () => 0.5
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, 1000, 30000, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ])
    expect(backoffDelay(1, 1000, 30000, () => 0)).toBe(800)
    expect(backoffDelay(1, 1000, 30000, () => 1)).toBe(1200)
  })

  it('reconnects after a drop without a reconnect storm, and resets after success', () => {
    vi.useFakeTimers()
    try {
      const socket = fakeSocket()
      const states: string[] = []
      const events: LyraEvent[] = []
      socket.onConnection((s) => states.push(s))
      socket.onEvent((e) => events.push(e))
      socket.start()
      expect(FakeSocket.instances).toHaveLength(1)
      FakeSocket.latest().open()
      FakeSocket.latest().emit({ type: 'tool_started', tool: 'calculator' })
      expect(events).toEqual([{ type: 'tool_started', tool: 'calculator' }])

      FakeSocket.latest().drop()
      expect(socket.connectionState).toBe('closed')
      vi.advanceTimersByTime(999)
      expect(FakeSocket.instances).toHaveLength(1) // waits the backoff, no immediate retry
      vi.advanceTimersByTime(1)
      expect(FakeSocket.instances).toHaveLength(2)
      FakeSocket.latest().drop() // second failure: 2 s
      vi.advanceTimersByTime(1999)
      expect(FakeSocket.instances).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(FakeSocket.instances).toHaveLength(3)
      FakeSocket.latest().open()
      expect(socket.retryAttempt).toBe(0)
      expect(states).toEqual(['closed', 'connecting', 'open', 'closed', 'connecting', 'closed', 'connecting', 'open'])

      socket.stop()
      vi.advanceTimersByTime(60000)
      expect(FakeSocket.instances).toHaveLength(3) // stopped means stopped
    } finally {
      vi.useRealTimers()
    }
  })

  it('authenticates with the bearer subprotocol when a token exists', () => {
    setApiToken('abcdefghijklmnop')
    const socket = fakeSocket()
    socket.start()
    expect(FakeSocket.latest().protocols).toEqual(['bearer.abcdefghijklmnop'])
    socket.stop()
  })
})

describe('activity reducer', () => {
  const run = (events: LyraEvent[], state: ActivityState = initialActivity) =>
    events.reduce((s, event, i) => activityReducer(s, { type: 'event', event, at: 1000 + i }), state)

  it('turns the real event sequence into a quiet timeline', () => {
    const state = run([
      { type: 'state', state: 'thinking' },
      { type: 'state', state: 'using_tool' },
      { type: 'tool_started', tool: 'calculator' },
      { type: 'tool_finished', tool: 'calculator', success: true },
      { type: 'state', state: 'thinking' },
      { type: 'response', content: '17 × 23 =\n\n391' },
      { type: 'state', state: 'idle' },
    ])
    expect(state.entries.map((e) => [e.kind, e.title, e.detail])).toEqual([
      ['thinking', 'Thinking', 'Elaborazione della richiesta'],
      ['tool', 'Using tool', 'calculator'],
      ['tool_done', 'Tool completed', 'calculator'],
      ['thinking', 'Thinking', 'Elaborazione della richiesta'],
      ['response', 'Response', '17 × 23 = 391'],
    ])
  })

  it('marks failures, trims long payloads and caps the history', () => {
    let state = run([
      { type: 'tool_finished', tool: 'notes_read', success: false },
      { type: 'error', message: 'x'.repeat(500) },
    ])
    expect(state.entries[0]).toMatchObject({ title: 'Tool failed', success: false })
    expect(state.entries[1].detail!.length).toBeLessThanOrEqual(160)
    state = run(Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => ({ type: 'tool_started', tool: `t${i}` }) as LyraEvent), state)
    expect(state.entries).toHaveLength(MAX_ENTRIES)
  })

  it('records connection changes once and supports clear', () => {
    let state = activityReducer(initialActivity, { type: 'connection', state: 'closed', at: 1 })
    expect(state.entries).toHaveLength(0) // never connected yet: nothing to report
    state = activityReducer(state, { type: 'connection', state: 'open', at: 2 })
    state = activityReducer(state, { type: 'connection', state: 'closed', at: 3 })
    state = activityReducer(state, { type: 'connection', state: 'closed', at: 4 })
    expect(state.entries.map((e) => e.title)).toEqual(['Connessa', 'Disconnessa'])
    expect(activityReducer(state, { type: 'clear' }).entries).toEqual([])
  })
})

describe('orb state machine', () => {
  it('maps real runtime signals to orb states', () => {
    const base = { connection: 'open' as const, runtime: 'idle' as const, responding: false }
    expect(deriveOrbState(base)).toBe('idle')
    expect(deriveOrbState({ ...base, runtime: 'thinking' })).toBe('thinking')
    expect(deriveOrbState({ ...base, runtime: 'using_tool' })).toBe('using_tool')
    expect(deriveOrbState({ ...base, runtime: 'error' })).toBe('error')
    expect(deriveOrbState({ ...base, responding: true })).toBe('response')
    // Busy states win over the short response pulse.
    expect(deriveOrbState({ ...base, runtime: 'thinking', responding: true })).toBe('thinking')
    expect(deriveOrbState({ ...base, connection: 'closed', runtime: 'thinking' })).toBe('offline')
    expect(deriveOrbState({ ...base, connection: 'connecting' })).toBe('offline')
  })

  it('never produces the reserved voice states', () => {
    const produced = new Set<OrbState>()
    for (const connection of ['open', 'closed', 'connecting'] as const)
      for (const runtime of ['idle', 'thinking', 'using_tool', 'error'] as const)
        for (const responding of [true, false]) produced.add(deriveOrbState({ connection, runtime, responding }))
    for (const future of FUTURE_ORB_STATES) {
      expect(produced.has(future)).toBe(false)
      expect(ORB_PARAMS[future]).toBeDefined() // renderer is ready for them
    }
  })

  it('makes every state visibly different, not a small speed change', () => {
    const idle = orbParams('idle')
    const thinking = orbParams('thinking')
    const tool = orbParams('using_tool')
    // Thinking: internal energy, 2-3x activity, violet more present, cyan/violet alternation.
    expect(thinking.flow).toBeGreaterThanOrEqual(idle.flow * 3)
    expect(thinking.speed).toBeGreaterThanOrEqual(idle.speed * 2.5)
    expect(thinking.core).toBeGreaterThanOrEqual(idle.core * 3)
    expect(thinking.purple).toBeGreaterThan(idle.purple)
    expect(thinking.alternate).toBe(1)
    // Thinking keeps the flux loops close; using tool extends them far out.
    expect(thinking.fluxReach).toBeLessThan(1)
    // Using tool: energy organised outwards (arcs, orbit), compact inside.
    expect(tool.flux).toBeGreaterThan(thinking.flux)
    expect(tool.fluxReach).toBeGreaterThan(thinking.fluxReach + 0.2)
    expect(tool.orbit).toBeGreaterThanOrEqual(thinking.orbit * 2)
    expect(tool.compression).toBeGreaterThan(thinking.compression)
    expect(tool.core).toBeLessThan(thinking.core)
    // Response: strongest glow; the wave itself is a one-shot pulse.
    expect(orbParams('response').glow).toBeGreaterThan(Math.max(idle.glow, thinking.glow, tool.glow))
    // ...and a livelier web than idle (no white flash: the wave is cyan, see orbShaders).
    expect(orbParams('response').discharge).toBeGreaterThan(idle.discharge)
    // Thinking crackles more than idle.
    expect(thinking.discharge).toBeGreaterThan(idle.discharge * 1.4)
    // Error: loses cohesion, jitters, violet drifts to magenta; not a red orb.
    expect(orbParams('error').dispersion).toBeGreaterThan(0.4)
    expect(orbParams('error').jitter).toBe(1)
    expect(orbParams('error').saturation).toBeGreaterThan(0.8)
    // Offline: almost still, desaturated, violet nearly off.
    expect(orbParams('offline').speed).toBeLessThan(idle.speed / 4)
    expect(orbParams('offline').saturation).toBeLessThan(0.3)
    expect(orbParams('offline').purple).toBeLessThan(0.1)
  })

  it('keeps a fast tool visible as using_tool', () => {
    const base = { connection: 'open' as const, responding: false }
    expect(deriveOrbState({ ...base, runtime: 'thinking', toolHold: true })).toBe('using_tool')
    expect(deriveOrbState({ ...base, runtime: 'idle', toolHold: true })).toBe('idle')
    expect(deriveOrbState({ ...base, runtime: 'error', toolHold: true })).toBe('error')
    expect(deriveOrbState({ ...base, connection: 'closed', runtime: 'thinking', toolHold: true })).toBe('offline')
  })

  it('picks lighter quality on phones and weak devices', () => {
    expect(pickQuality({ coarsePointer: false, cores: 8, minSide: 900 })).toBe(QUALITY.high)
    expect(pickQuality({ coarsePointer: true, cores: 6, minSide: 390 })).toBe(QUALITY.medium)
    expect(pickQuality({ coarsePointer: true, cores: 2, minSide: 390 })).toBe(QUALITY.low)
    expect(QUALITY.medium.shell).toBeLessThan(QUALITY.high.shell)
    expect(Object.values(QUALITY).every((q) => q.maxPixelRatio <= 2)).toBe(true)
  })

  it('frames the orb per view: large on Home, smaller in Chat, a mark elsewhere', () => {
    const home = orbFrame('home', 1440, 900)
    const chat = orbFrame('chat', 1440, 900)
    const brain = orbFrame('brain', 1440, 900)
    expect(home.size).toBeGreaterThan(chat.size)
    expect(chat.y).toBeGreaterThan(home.y)
    expect(brain.size * 900).toBeCloseTo(46)
    expect(brain.x).toBeLessThan(-0.9)
    expect(orbFrame('home', 390, 844).size).toBeGreaterThan(home.size)
  })
})

describe('notes helpers', () => {
  it('strips YAML frontmatter and turns wikilinks into in-app searches', () => {
    const md = '---\ntags: [a]\n---\n# Titolo\n\nVedi [[progetti/crm|il CRM]] e [[idee]]. ![[img.png]]'
    expect(stripFrontmatter(md).startsWith('# Titolo')).toBe(true)
    const out = prepareNote(md)
    expect(out).toContain(`[il CRM](${WIKI_PREFIX}progetti%2Fcrm)`)
    expect(out).toContain(`[idee](${WIKI_PREFIX}idee)`)
    expect(out).toContain('*img.png*')
    expect(noteTitle('x/y.md', md)).toBe('Titolo')
    expect(noteTitle('x/y.md', 'senza titolo')).toBe('y')
  })

  it('cleans search excerpts to plain text', () => {
    expect(excerptText('--- tags: [idee] --- # Idee progetti - [x] **Lyra** | a | `code` clienti_attivi')).toBe(
      'Idee progetti Lyra a code clienti_attivi',
    )
    expect(excerptText('> Nota [link](https://x.y) e [[crm|il CRM]]')).toBe('Nota link e il CRM')
  })
})

describe('prettyModel', () => {
  it('shortens Ollama tags to the reference label', () => {
    expect(prettyModel('openbmb/minicpm5-2b:q8_0')).toBe('MiniCPM 2B')
    expect(prettyModel('qwen2.5-3b-instruct:q4_K_M')).toBe('Qwen 3B')
    expect(prettyModel('custom-model:latest')).toBe('custom-model')
  })
})

describe('ring morph (thinking / using_tool)', () => {
  const run = (ring: RingMorph, seconds: number, working: boolean) => {
    let shape = ring.update(0, working)
    for (let t = 0; t < seconds; t += 0.05) shape = ring.update(0.05, working)
    return shape
  }

  it('breaks the sphere into a ring while working and holds it', () => {
    const ring = new RingMorph()
    expect(ring.update(0.05, false)).toEqual(SPHERE)
    const early = run(ring, 1.0, true)
    expect(early.scatter).toBeGreaterThan(0.3) // decomposition first
    const formed = run(ring, ENTER_SECONDS + 4, true)
    expect(formed.morph).toBe(1)
    expect(formed.energy).toBe(1) // thinking energy borrowed
    expect(formed.spin).toBeGreaterThan(0)
  })

  it('closes back into the sphere when the work ends', () => {
    const ring = new RingMorph()
    run(ring, 6, true)
    const leaving = run(ring, 0.6, false)
    expect(leaving.morph).toBeGreaterThan(0)
    expect(run(ring, EXIT_SECONDS, false)).toEqual(SPHERE)
  })

  it('resumes the ring when work starts again while it is still closing', () => {
    const ring = new RingMorph()
    run(ring, 6, true)
    run(ring, 0.3, false)
    const back = ring.update(0.05, true)
    expect(back.morph).toBeGreaterThan(0.8) // no restart from the sphere
  })
})

describe('speaking', () => {
  it('is lively: more turbulent and irregular than idle, with rhythm', () => {
    const idle = orbParams('idle')
    const speaking = orbParams('speaking')
    expect(speaking.speed).toBeGreaterThanOrEqual(idle.speed * 3)
    expect(speaking.deform).toBeGreaterThanOrEqual(idle.deform * 2.5)
    expect(speaking.flow).toBeGreaterThan(idle.flow * 4)
    expect(speaking.rhythm).toBeGreaterThan(1)
  })
})

describe('workCaption', () => {
  it('names the real tools in plain Italian and stays silent when idle', () => {
    expect(workCaption('idle', null)).toBeNull()
    expect(workCaption('response', null)).toBeNull()
    expect(workCaption('thinking', null)).toBe('Sto pensando…')
    expect(workCaption('using_tool', 'calculator')).toBe('Uso la calcolatrice…')
    expect(workCaption('using_tool', 'notes_search')).toBe('Uso le note…')
    expect(workCaption('using_tool', 'browser_navigate')).toBe('Uso il browser…')
    expect(workCaption('using_tool', 'memory_retrieve')).toBe('Uso la memoria…')
    expect(workCaption('using_tool', 'some_new_tool')).toBe('Uso some new tool…')
    expect(workCaption('using_tool', null)).toBe('Uso uno strumento…')
  })
})

describe('standaloneGap (iOS home-screen app short of the screen)', () => {
  const setScreen = (inner: [number, number], screen: [number, number], standalone: boolean) => {
    vi.stubGlobal('innerWidth', inner[0])
    vi.stubGlobal('innerHeight', inner[1])
    vi.stubGlobal('screen', { width: screen[0], height: screen[1] })
    vi.stubGlobal('navigator', { ...navigator, standalone })
  }

  it('measures the missing strip only in standalone mode', () => {
    setScreen([402, 815], [402, 874], true)
    expect(standaloneGap()).toBe(59)
    setScreen([402, 815], [402, 874], false) // browser tab: never touched
    expect(standaloneGap()).toBe(0)
  })

  it('ignores implausible differences and full-height layouts', () => {
    setScreen([402, 874], [402, 874], true)
    expect(standaloneGap()).toBe(0)
    setScreen([402, 500], [402, 874], true) // e.g. keyboard open: not a status-bar gap
    expect(standaloneGap()).toBe(0)
  })

  it('uses the short screen side in landscape', () => {
    setScreen([874, 380], [402, 874], true)
    expect(standaloneGap()).toBe(22)
  })
})
