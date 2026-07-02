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
    icon: data.icon || '/image/icon.png',
    badge: data.badge || '/image/icon.png',
    tag: data.tag || `orchidea-${Date.now()}`,
    renotify: true,
    data: { url: data.url || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification?.data?.url || '/'

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
