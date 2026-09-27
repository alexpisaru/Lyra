import { useEffect, useRef, useState } from 'react'
import type { OrbFrame, OrbScene } from '../lib/orbScene'
import type { OrbState } from '../lib/orbState'
import { supportsWebGL } from '../lib/webgl'

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface LyraOrbProps {
  state: OrbState
  frame: OrbFrame
}

/**
 * The live orb: one full-screen WebGL canvas for the whole session (switching
 * tabs only changes `frame`, never recreates the context). Three.js is loaded
 * as a separate chunk so the interface paints first; where WebGL2 is missing a
 * quiet CSS orb stands in.
 */
export function LyraOrb({ state, frame }: LyraOrbProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<OrbScene | null>(null)
  const latest = useRef({ state, frame })
  const [fallback, setFallback] = useState(() => !supportsWebGL())

  useEffect(() => {
    latest.current = { state, frame }
  })

  useEffect(() => {
    const host = hostRef.current
    if (fallback || !host) return
    let cancelled = false
    let teardown: (() => void) | null = null

    void import('../lib/orbScene').then(({ OrbScene, pickQuality }) => {
      if (cancelled) return
      // A fresh canvas per scene: dispose() force-loses the WebGL context, so a
      // canvas must never be reused (React StrictMode mounts effects twice).
      const canvas = document.createElement('canvas')
      canvas.className = 'orb-canvas'
      host.appendChild(canvas)
      let scene: OrbScene
      try {
        scene = new OrbScene(canvas, {
          quality: pickQuality({
            coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
            cores: navigator.hardwareConcurrency || 4,
            memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
            minSide: Math.min(window.innerWidth, window.innerHeight),
          }),
          reducedMotion: prefersReducedMotion(),
        })
      } catch {
        // WebGL2 existed but the renderer could not start (driver/blocklist).
        canvas.remove()
        setFallback(true)
        return
      }
      sceneRef.current = scene
      scene.setState(latest.current.state)
      scene.setFrame(latest.current.frame, true)
      const resize = () => scene.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1)
      resize()
      const observer = new ResizeObserver(resize)
      observer.observe(canvas)
      const onVisibility = () => (document.hidden ? scene.stop() : scene.start())
      const onLost = (event: Event) => {
        event.preventDefault()
        setFallback(true)
      }
      document.addEventListener('visibilitychange', onVisibility)
      canvas.addEventListener('webglcontextlost', onLost)
      if (!document.hidden) scene.start()
      teardown = () => {
        document.removeEventListener('visibilitychange', onVisibility)
        canvas.removeEventListener('webglcontextlost', onLost)
        observer.disconnect()
        scene.dispose()
        canvas.remove()
        sceneRef.current = null
      }
    })

    return () => {
      cancelled = true
      teardown?.()
    }
  }, [fallback])

  useEffect(() => {
    sceneRef.current?.setState(state)
  }, [state])

  useEffect(() => {
    sceneRef.current?.setFrame(frame)
  }, [frame])

  return (
    <div className="orb-layer" data-orb-state={state} data-orb-renderer={fallback ? 'css' : 'webgl'} aria-hidden="true">
      {fallback ? (
        <div
          className="orb-fallback"
          style={{
            width: `calc(${frame.size} * min(100vw, 100dvh))`,
            transform: `translate(calc(${frame.x} * 50vw), calc(${-frame.y} * 50dvh))`,
            opacity: 0.4 + frame.presence * 0.6,
          }}
        />
      ) : (
        <div ref={hostRef} className="orb-host" />
      )}
    </div>
  )
}
