// ELauncher Remote — app shell service worker.
// Network-first so updates land instantly; cached shell keeps the app opening
// offline. API traffic (Supabase) is never cached — live data only.
const SHELL = 'elauncher-remote-v2'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['./', './manifest.webmanifest', './icon-192.png', './icon-512.png']))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== location.origin) return // Supabase and friends: straight to the network
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone()
        caches
          .open(SHELL)
          .then((cache) => cache.put(event.request, copy))
          .catch(() => {})
        return response
      })
      .catch(() =>
        caches.match(event.request, { ignoreSearch: true }).then((hit) => hit ?? caches.match('./'))
      )
  )
})
