import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom has no layout: scrolling is a no-op here.
Element.prototype.scrollIntoView = vi.fn()

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  history.replaceState(null, '', '/')
})
