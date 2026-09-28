import { useEffect, useState, type RefObject } from 'react'

/** Live CSS-pixel size of an element (ResizeObserver), falling back to the window. */
export function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}
