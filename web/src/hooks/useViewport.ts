import { useEffect, useState } from 'react'

export interface Viewport {
  width: number
  height: number
  /** px of the layout viewport currently covered by the on-screen keyboard */
  keyboard: number
}

function read(): Viewport {
  const vv = window.visualViewport
  const height = window.innerHeight
  const keyboard = vv ? Math.max(0, Math.round(height - vv.height - vv.offsetTop)) : 0
  return { width: window.innerWidth, height, keyboard: keyboard > 80 ? keyboard : 0 }
}

/**
 * Window size plus iOS keyboard height (Safari does not resize the layout
 * viewport, so fixed bottom elements must be lifted by hand).
 */
export function useViewport(): Viewport {
  const [viewport, setViewport] = useState(read)
  useEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setViewport(read()))
    }
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [])
  return viewport
}
