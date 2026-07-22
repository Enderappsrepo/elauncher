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
//
// Skipped while this build is staged at /elauncher/next/: there is no sw.js
// there, and registering one under a staging scope would cache a half-ported
// panel onto phones that then have to be talked out of it.
const staging = import.meta.env.BASE_URL.endsWith('/next/')
if ('serviceWorker' in navigator && !staging) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('sw.js').catch(() => {
      // no service worker (private window, unsupported browser) — the panel
      // still works, it just loses offline open and push
    })
  })
}
