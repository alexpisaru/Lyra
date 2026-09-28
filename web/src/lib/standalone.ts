/**
 * iOS home-screen apps (standalone, status bar "black-translucent",
 * viewport-fit=cover) can lay the page out shorter than the screen by about the
 * status bar height, leaving a bare strip under the app. Measure that strip and
 * expose it as --standalone-gap so the app surface can extend over it.
 *
 * Only in standalone mode and only for a plausible gap (a status-bar-sized
 * difference); a normal browser tab is never touched.
 */

const MAX_GAP = 120

function standalone() {
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
}

export function standaloneGap(): number {
  if (!standalone() || !window.screen) return 0
  const portrait = window.innerHeight >= window.innerWidth
  const screenHeight = portrait
    ? Math.max(window.screen.width, window.screen.height)
    : Math.min(window.screen.width, window.screen.height)
  const gap = Math.round(screenHeight - window.innerHeight)
  return gap > 0 && gap <= MAX_GAP ? gap : 0
}

export function fixStandaloneHeight() {
  const apply = () => {
    document.documentElement.style.setProperty('--standalone-gap', `${standaloneGap()}px`)
  }
  apply()
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', apply)
}
