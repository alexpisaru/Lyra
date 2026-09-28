import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityView } from './components/ActivityView'
import { Backdrop } from './components/Backdrop'
import { BottomNav, type View } from './components/BottomNav'
import { BrainView } from './components/BrainView'
import { ChatView } from './components/ChatView'
import { LyraOrb } from './components/LyraOrb'
import { StatusPill } from './components/StatusPill'
import { useChat } from './hooks/useChat'
import { useLyraState, type LyraStateOptions } from './hooks/useLyraState'
import { useElementSize } from './hooks/useElementSize'
import { useViewport } from './hooks/useViewport'
import { captionTop, orbFrame } from './lib/frames'
import { workCaption } from './lib/orbState'

const VIEWS: View[] = ['home', 'chat', 'brain', 'activity']

function initialView(): View {
  const hash = window.location.hash.replace('#', '') as View
  return VIEWS.includes(hash) ? hash : 'home'
}

export default function App({ live }: { live?: LyraStateOptions } = {}) {
  const lyra = useLyraState(live)
  const chat = useChat()
  const viewport = useViewport()
  const heroRef = useRef<HTMLDivElement>(null)
  const hero = useElementSize(heroRef)
  const [view, setView] = useState<View>(initialView)
  const panelView = view === 'brain' || view === 'activity'
  const [seenActivity, setSeenActivity] = useState(0)
  // Connection rows are bookkeeping; only real Lyra activity lights the badge.
  const activityCount = lyra.activity.filter((entry) => entry.kind !== 'connection').length

  const navigate = (next: View) => {
    // Entering or leaving Activity marks everything so far as seen.
    if (next === 'activity' || view === 'activity') setSeenActivity(activityCount)
    setView(next)
    history.replaceState(null, '', next === 'home' ? window.location.pathname : `#${next}`)
  }

  useEffect(() => {
    const onHash = () => setView(initialView())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // In Chat the orb recedes while you read a finished conversation, and comes back
  // to full intensity as soon as Lyra works again (the orb itself is unchanged).
  const reading = view === 'chat' && chat.turns.length > 0 && lyra.orbState === 'idle'
  // the working ring is wider than the sphere: in Chat, frame it a little smaller
  const working = lyra.orbState === 'thinking' || lyra.orbState === 'using_tool'
  const frame = useMemo(() => {
    const base = orbFrame(view, hero.width, hero.height)
    if (reading) return { ...base, presence: 0.55 }
    if (working && view === 'chat') return { ...base, size: base.size * 0.78, y: base.y + 0.04 }
    return base
  }, [view, hero.width, hero.height, reading, working])

  const orbState = lyra.orbState
  const signal = lyra.signal

  const work = workCaption(lyra.orbState, lyra.tool)
  const caption =
    lyra.orbState === 'offline' ? (lyra.reachable === false ? 'Lyra non raggiungibile' : 'Connessione…') : work

  return (
    <div
      className="app"
      data-view={view}
      data-keyboard={viewport.keyboard > 0 || undefined}
      style={{ '--kb': `${viewport.keyboard}px` } as React.CSSProperties}
    >
      <div className="hero" ref={heroRef}>
      <Backdrop />
      <LyraOrb state={orbState} frame={frame} signal={signal} />
      <StatusPill
        key={panelView ? 'compact' : 'card'}
        compact={panelView}
        status={lyra.status}
        reachable={lyra.reachable}
        connection={lyra.connection}
      />

      <main className="stage">
        {view === 'home' ? (
          <section className="view home-view" aria-label="Home">
            <h1 className="sr-only">Lyra</h1>
            <p
              className="home-caption"
              data-visible={Boolean(caption)}
              style={{ top: captionTop(frame, hero.width, hero.height, working) }}
              aria-live="polite"
            >
              {caption ?? ''}
            </p>
          </section>
        ) : null}
        {view === 'chat' ? <ChatView chat={chat} status={lyra.status} online={lyra.online} working={work} /> : null}
        {view === 'brain' ? <BrainView knowledgeEnabled={lyra.status ? lyra.status.knowledge.enabled : null} /> : null}
        {view === 'activity' ? (
          <ActivityView entries={lyra.activity} connection={lyra.connection} onClear={lyra.clearActivity} />
        ) : null}
      </main>

      <BottomNav view={view} onChange={navigate} activityBadge={activityCount > seenActivity} />
      </div>
    </div>
  )
}
