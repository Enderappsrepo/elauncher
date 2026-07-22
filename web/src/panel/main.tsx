import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@web/styles/base.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// The panel is an installable PWA; the shell service worker keeps it opening
// offline and carries push notifications from the hosting boxes.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('sw.js').catch(() => {
      // no service worker (private window, unsupported browser) — the panel
      // still works, it just loses offline open and push
    })
  })
}
