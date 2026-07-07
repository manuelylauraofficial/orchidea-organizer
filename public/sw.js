const CACHE_VERSION = 'orchidea-organizer-v9'

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

function absoluteUrl(path) {
  try {
    return new URL(path, self.location.origin).href
  } catch (_error) {
    return path
  }
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_error) {
    data = { title: 'Orchidea Organizer', body: event.data?.text() || 'Nuova notifica' }
  }

  const title = data.title || 'Orchidea Organizer'
  const options = {
    body: data.body || 'Hai un nuovo aggiornamento importante.',
    icon: absoluteUrl(data.icon || '/image/icon.png'),
    badge: absoluteUrl(data.badge || '/image/icon.png'),
    tag: data.tag || `orchidea-${Date.now()}`,
    renotify: true,
    timestamp: Date.now(),
    data: { url: data.url || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = absoluteUrl(event.notification?.data?.url || '/')

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl).catch(() => {})
          return client.focus()
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl)
      return undefined
    })
  )
})
