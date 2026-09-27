import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { ActivityView } from './components/ActivityView'
import { BottomNav, type View } from './components/BottomNav'
import { BrainView } from './components/BrainView'
import { ChatView } from './components/ChatView'
import { LyraOrb } from './components/LyraOrb'
import { StatusPill } from './components/StatusPill'
import { useChat } from './hooks/useChat'
import { useLyraState, type LyraStateOptions, type OrbSignal } from './hooks/useLyraState'
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
  const [view, setView] = useState<View>(initialView)
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
    () => orbFrame(view, viewport.width, viewport.height),
    [view, viewport.width, viewport.height],
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
      style={{ '--kb': `${viewport.keyboard}px` } as React.CSSProperties}
    >
      <div className="backdrop" aria-hidden="true" />
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
      <StatusPill status={lyra.status} reachable={lyra.reachable} connection={lyra.connection} />

      <main className="stage">
        {view === 'home' ? (
          <section className="view home-view" aria-label="Home">
            <h1 className="sr-only">Lyra</h1>
            <p
              className="home-caption"
              data-visible={Boolean(caption)}
              style={{ top: captionTop(frame, viewport.width, viewport.height) }}
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
  )
}
