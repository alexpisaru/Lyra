import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityView } from './components/ActivityView'
import { Backdrop } from './components/Backdrop'
import { BottomNav, type View } from './components/BottomNav'
import { BrainView } from './components/BrainView'
import { ChatView } from './components/ChatView'
import { LyraOrb } from './components/LyraOrb'
import { StateGallery } from './components/StateGallery'
import { StatusPill } from './components/StatusPill'
import { useChat } from './hooks/useChat'
import { useLyraState, type LyraStateOptions, type OrbSignal } from './hooks/useLyraState'
import { useElementSize, useMedia } from './hooks/useElementSize'
import { useViewport } from './hooks/useViewport'
import { captionTop, orbFrame } from './lib/frames'
import { ORB_LABEL, type OrbState } from './lib/orbState'

// Development-only orb inspector: the condition is constant-folded away in production builds
// (and kept out of the Vitest runs, where MODE is 'test').
const DevOrbPanel =
  import.meta.env.DEV && import.meta.env.MODE !== 'test' ? lazy(() => import('./components/DevOrbPanel')) : null

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
  // The reference's "Stati principali" column, on screens wide enough for it.
  const showGallery = useMedia('(min-width: 1200px) and (min-height: 620px)')
  const [view, setView] = useState<View>(initialView)
  const panelView = view === 'brain' || view === 'activity'
  const [seenActivity, setSeenActivity] = useState(0)
  const [forcedOrb, setForcedOrb] = useState<OrbState | null>(null)
  const [devSignal, setDevSignal] = useState<OrbSignal | null>(null)
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

  const frame = useMemo(
    () => orbFrame(view, hero.width, hero.height),
    [view, hero.width, hero.height],
  )

  const orbState = forcedOrb ?? lyra.orbState
  // The most recent one-shot event wins, whether from /ws or the dev panel.
  const signal = devSignal && (!lyra.signal || devSignal.at > lyra.signal.at) ? devSignal : lyra.signal

  const caption =
    lyra.orbState === 'offline'
      ? lyra.reachable === false
        ? 'Lyra non raggiungibile'
        : 'Connessione…'
      : lyra.orbState === 'idle'
        ? null
        : ORB_LABEL[lyra.orbState]

  return (
    <div
      className="app"
      data-view={view}
      data-keyboard={viewport.keyboard > 0 || undefined}
      data-gallery={showGallery || undefined}
      style={{ '--kb': `${viewport.keyboard}px` } as React.CSSProperties}
    >
      <div className="hero" ref={heroRef}>
      <Backdrop />
      <LyraOrb state={orbState} frame={frame} signal={signal} />
      {DevOrbPanel ? (
        <Suspense fallback={null}>
          <DevOrbPanel
            forced={forcedOrb}
            live={lyra.orbState}
            onForce={setForcedOrb}
            onPulse={(kind) => setDevSignal({ kind, at: performance.now() })}
          />
        </Suspense>
      ) : null}
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
              style={{ top: captionTop(frame, hero.width, hero.height) }}
              aria-live="polite"
            >
              {caption ?? ''}
            </p>
          </section>
        ) : null}
        {view === 'chat' ? <ChatView chat={chat} status={lyra.status} online={lyra.online} /> : null}
        {view === 'brain' ? <BrainView knowledgeEnabled={lyra.status ? lyra.status.knowledge.enabled : null} /> : null}
        {view === 'activity' ? (
          <ActivityView entries={lyra.activity} connection={lyra.connection} onClear={lyra.clearActivity} />
        ) : null}
      </main>

      <BottomNav view={view} onChange={navigate} activityBadge={activityCount > seenActivity} />
      </div>
      {showGallery ? <StateGallery active={orbState} /> : null}
    </div>
  )
}
