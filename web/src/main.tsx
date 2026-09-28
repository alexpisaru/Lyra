import '@fontsource-variable/jost'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Service worker only in production builds; it caches the app shell and static
// assets, never /api or /ws. Browsers register it only in secure contexts
// (HTTPS or localhost): on plain-HTTP LAN the app still works, just not offline.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }))
}
