import { useEffect, useRef, useState } from 'react'
import type { OrbGallery } from '../lib/orbScene'
import { SHOWCASE_STATES, type OrbState } from '../lib/orbState'
import { supportsWebGL } from '../lib/webgl'

interface StateGalleryProps {
  /** live orb state: its card is highlighted */
  active: OrbState
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * "Stati principali": the six orb states as live mini previews, rendered by a
 * single shared WebGL canvas (OrbGallery) laid over the cards.
 */
export function StateGallery({ active }: StateGalleryProps) {
  const rootRef = useRef<HTMLElement>(null)
  const slots = useRef<(HTMLDivElement | null)[]>([])
  const [webgl] = useState(supportsWebGL)

  useEffect(() => {
    const root = rootRef.current
    if (!webgl || !root) return
    let cancelled = false
    let teardown: (() => void) | null = null
    void import('../lib/orbScene').then(({ OrbGallery: Gallery }) => {
      if (cancelled) return
      const canvas = document.createElement('canvas')
      canvas.className = 'gallery-canvas'
      root.appendChild(canvas)
      let gallery: OrbGallery
      try {
        gallery = new Gallery(
          canvas,
          SHOWCASE_STATES.map((s, i) => ({ state: s.state, element: slots.current[i]! })),
          { reducedMotion: prefersReducedMotion() },
        )
      } catch {
        canvas.remove()
        return
      }
      const resize = () => gallery.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1)
      resize()
      const observer = new ResizeObserver(resize)
      observer.observe(canvas)
      const onVisibility = () => (document.hidden ? gallery.stop() : gallery.start())
      document.addEventListener('visibilitychange', onVisibility)
      if (!document.hidden) gallery.start()
      teardown = () => {
        document.removeEventListener('visibilitychange', onVisibility)
        observer.disconnect()
        gallery.dispose()
        canvas.remove()
      }
    })
    return () => {
      cancelled = true
      teardown?.()
    }
  }, [webgl])

  return (
    <aside ref={rootRef} className="gallery" aria-label="Stati principali">
      <h2 className="gallery-title">Stati principali</h2>
      <ul className="gallery-grid">
        {SHOWCASE_STATES.map((s, i) => (
          <li key={s.state} className="gallery-card" data-active={s.state === active || undefined}>
            <div
              className="gallery-preview"
              data-fallback={!webgl || undefined}
              ref={(el) => {
                slots.current[i] = el
              }}
            />
            <p className="gallery-name">{s.title}</p>
            <p className="gallery-sub">{s.subtitle}</p>
          </li>
        ))}
      </ul>
    </aside>
  )
}
