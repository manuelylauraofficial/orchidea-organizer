import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'

const TABS = [
  { id: 'dashboard', label: 'Home', icon: '🏠' },
  { id: 'tasks', label: 'Attività', icon: '✅' },
  { id: 'calendar', label: 'Agenda', icon: '📅' },
  { id: 'lists', label: 'Liste', icon: '🧾' },
  { id: 'notes', label: 'Note', icon: '📝' },
  { id: 'documents', label: 'Documenti', icon: '📂' },
  { id: 'budget', label: 'Budget', icon: '💶' },
  { id: 'announcements', label: 'Messaggi', icon: '📣' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'settings', label: 'Impostazioni', icon: '⚙️' },
]

const todayISO = () => new Date().toISOString().slice(0, 10)
const fmtDate = (value) => value ? new Date(value).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const fmtDateTime = (value) => value ? new Date(value).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
const money = (n) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(Number(n || 0))

const NOTIFICATION_TABLES = {
  tasks: { label: 'attività', field: 'title', icon: '✅' },
  events: { label: 'evento in agenda', field: 'title', icon: '📅' },
  notes: { label: 'nota', field: 'title', icon: '📝' },
  lists: { label: 'lista', field: 'title', icon: '🧾' },
  documents: { label: 'documento', field: 'title', icon: '📂' },
  expenses: { label: 'spesa', field: 'title', icon: '💶' },
  announcements: { label: 'messaggio', field: 'title', icon: '📣' },
}

function canUseBrowserNotifications() {
  return typeof window !== 'undefined' && 'Notification' in window
}

function getNotificationPermission() {
  if (!canUseBrowserNotifications()) return 'unsupported'
  return window.Notification.permission
}

async function showBrowserNotification(title, options) {
  if (getNotificationPermission() !== 'granted') return

  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready
    if (registration?.showNotification) {
      await registration.showNotification(title, options)
      return
    }
  }

  new window.Notification(title, options)
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
  return outputArray
}

async function getServiceWorkerRegistration() {
  if (!('serviceWorker' in navigator)) throw new Error('Service Worker non supportato su questo dispositivo.')
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (existing) return existing
  return navigator.serviceWorker.register('/sw.js')
}

function App() {
  const missingEnv = !import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [profile, setProfile] = useState(null)
  const [spaces, setSpaces] = useState([])
  const [currentSpace, setCurrentSpace] = useState(null)
  const [active, setActive] = useState('dashboard')
  const [toast, setToast] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState(getNotificationPermission)
  const [notifications, setNotifications] = useState([])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [pushStatus, setPushStatus] = useState('')
  const membersRef = useRef([])
  const [data, setData] = useState({
    tasks: [], events: [], notes: [], lists: [], documents: [], expenses: [], announcements: [], members: []
  })

  const user = session?.user || null

  useEffect(() => {
    membersRef.current = data.members
  }, [data.members])

  useEffect(() => {
    let mounted = true

    async function init() {
      const { data: sessionData } = await supabase.auth.getSession()
      if (mounted) {
        if (sessionData.session?.user) setWorkspaceLoading(true)
        setSession(sessionData.session)
        setLoading(false)
      }
    }

    init()

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      if (nextSession?.user) setWorkspaceLoading(true)
      if (!nextSession) {
        setProfile(null)
        setSpaces([])
        setCurrentSpace(null)
        setWorkspaceLoading(false)
        setData({ tasks: [], events: [], notes: [], lists: [], documents: [], expenses: [], announcements: [], members: [] })
        setNotifications([])
      }
    })

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!user) {
      setWorkspaceLoading(false)
      return
    }
    ensureProfileAndSpaces(user)
  }, [user?.id])

  useEffect(() => {
    if (!currentSpace?.id) return
    loadAll(currentSpace.id)

    const tables = Object.keys(NOTIFICATION_TABLES)
    const channel = supabase.channel(`space-${currentSpace.id}`)

    tables.forEach((table) => {
      channel.on('postgres_changes', {
        event: '*',
        schema: 'public',
        table,
        filter: `space_id=eq.${currentSpace.id}`,
      }, (payload) => {
        handleRealtimeChange(table, payload)
        loadAll(currentSpace.id)
      })
    })

    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'list_items' }, () => loadAll(currentSpace.id))
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'space_members' }, () => loadAll(currentSpace.id))
    channel.subscribe()

    return () => supabase.removeChannel(channel)
  }, [currentSpace?.id, user?.id])

  useEffect(() => {
    if (!user?.id) return
    loadNotifications()

    const channel = supabase.channel(`notifications-${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'app_notifications',
        filter: `recipient_id=eq.${user.id}`,
      }, (payload) => {
        const row = payload.new
        setNotifications((prev) => [row, ...prev].slice(0, 50))
        showToast(row.body ? `${row.title}: ${row.body}` : row.title)
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [user?.id])

  function showToast(message, duration = 4200) {
    setToast(message)
    window.setTimeout(() => setToast(''), duration)
  }

  async function requestNotifications() {
    setPushStatus('')

    if (!canUseBrowserNotifications()) {
      showToast('Questo dispositivo o browser non supporta le notifiche push.', 7000)
      setPushStatus('❌ Browser non supportato: manca la Notification API.')
      return
    }
    if (!('PushManager' in window)) {
      showToast('Questo browser non supporta Web Push.', 7000)
      setPushStatus('❌ Browser non supportato: manca PushManager.')
      return
    }
    if (!('serviceWorker' in navigator)) {
      showToast('Service Worker non supportato su questo dispositivo.', 7000)
      setPushStatus('❌ Service Worker non supportato.')
      return
    }
    if (!window.isSecureContext && window.location.hostname !== 'localhost') {
      showToast('Le notifiche push richiedono HTTPS. Apri l’app dal link Vercel o dall’icona installata.', 8000)
      setPushStatus('❌ Contesto non sicuro: apri l’app in HTTPS.')
      return
    }
    if (!user?.id || !currentSpace?.id) {
      showToast('Apri prima uno spazio Orchidea.', 6000)
      setPushStatus('❌ Nessuno spazio attivo.')
      return
    }

    const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim()
    if (!vapidPublicKey) {
      showToast('Manca VITE_VAPID_PUBLIC_KEY su Vercel/.env. Aggiungila per abilitare le push vere.', 9000)
      setPushStatus('❌ VITE_VAPID_PUBLIC_KEY mancante nel frontend.')
      return
    }

    try {
      setPushStatus('1/5 Richiedo permesso notifiche…')
      const permission = await window.Notification.requestPermission()
      setNotificationPermission(permission)
      if (permission !== 'granted') {
        showToast('Notifiche non attivate. Puoi abilitarle dalle impostazioni del browser.', 7000)
        setPushStatus(`❌ Permesso notifiche: ${permission}`)
        return
      }

      setPushStatus('2/5 Registro Service Worker…')
      const registration = await getServiceWorkerRegistration()
      await registration.update().catch(() => {})
      await navigator.serviceWorker.ready

      // Test locale: verifica che permesso + service worker funzionino sul dispositivo.
      await showBrowserNotification('Test locale Orchidea', {
        body: 'Permesso notifiche e Service Worker funzionano su questo dispositivo.',
        icon: '/image/icon.png',
        badge: '/image/icon.png',
        tag: `orchidea-local-test-${Date.now()}`,
        data: { url: '/' },
      }).catch(() => {})

      setPushStatus('3/5 Ricreo la subscription Web Push…')
      const oldSubscription = await registration.pushManager.getSubscription()
      if (oldSubscription) {
        // Importante: se le chiavi VAPID sono cambiate, la vecchia subscription non riceve più.
        await oldSubscription.unsubscribe().catch(() => {})
        await supabase.from('push_subscriptions').update({ active: false }).eq('endpoint', oldSubscription.endpoint)
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      })

      const json = subscription.toJSON()
      const { error } = await supabase.from('push_subscriptions').upsert({
        user_id: user.id,
        space_id: currentSpace.id,
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        user_agent: navigator.userAgent,
        active: true,
      }, { onConflict: 'endpoint' })

      if (error) throw error

      const { count: savedCount, error: countError } = await supabase
        .from('push_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('active', true)

      if (countError) throw countError

      setPushStatus(`4/5 Dispositivo salvato (${savedCount || 1} attivo). Invio test server…`)
      const testResult = await sendPushNotification({
        kind: 'test',
        title: 'Notifiche Orchidea attive',
        body: 'Questo telefono riceverà le notifiche importanti dell’organizer.',
        priority: 'alta',
        recipientIds: [user.id],
        includeActor: true,
        silentIfNoRecipients: false,
      })

      if (testResult?.push_sent > 0) {
        const msg = `✅ Test push OK: inviate ${testResult.push_sent}/${testResult.subscriptions || testResult.push_sent}.`
        setPushStatus(msg)
        showToast('Notifiche push attivate. Ti ho inviato una notifica di test.', 7000)
      } else {
        const errors = Array.isArray(testResult?.errors) && testResult.errors.length
          ? ` Errori: ${testResult.errors.map((e) => `${e.status || 'no-status'} ${e.message || ''}`).join(' | ')}`
          : ''
        const msg = `⚠️ Test server non consegnato. Destinatari: ${testResult?.recipients ?? '—'}, dispositivi: ${testResult?.subscriptions ?? '—'}, inviate: ${testResult?.push_sent ?? 0}.${errors}`
        setPushStatus(msg)
        showToast('Dispositivo salvato, ma il test push server non è arrivato. Leggi il riquadro diagnostica sotto.', 9000)
      }
    } catch (error) {
      const message = error?.message || 'Non sono riuscito ad attivare le notifiche push.'
      setPushStatus(`❌ Errore push: ${message}`)
      showToast(message, 9000)
    }
  }

  async function loadNotifications() {
    if (!user?.id) return
    const { data: rows, error } = await supabase
      .from('app_notifications')
      .select('*')
      .eq('recipient_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (!error) setNotifications(rows || [])
  }

  async function markNotificationsRead() {
    if (!user?.id) return
    const now = new Date().toISOString()
    setNotifications((prev) => prev.map((n) => n.read_at ? n : { ...n, read_at: now }))
    await supabase
      .from('app_notifications')
      .update({ read_at: now })
      .eq('recipient_id', user.id)
      .is('read_at', null)
  }

  async function markNotificationRead(notificationId) {
    if (!user?.id || !notificationId) return
    const now = new Date().toISOString()
    setNotifications((prev) => prev.map((n) => n.id === notificationId ? { ...n, read_at: n.read_at || now } : n))
    const { error } = await supabase
      .from('app_notifications')
      .update({ read_at: now })
      .eq('id', notificationId)
      .eq('recipient_id', user.id)

    if (error) {
      showToast('Non sono riuscito a segnare la notifica come letta.')
      await loadNotifications()
    }
  }

  async function sendPushNotification({ kind, title, body, priority = 'normale', sourceTable = null, sourceId = null, recipientIds = null, includeActor = false, silentIfNoRecipients = false }) {
    if (!user?.id) return null
    const payload = {
      space_id: currentSpace?.id || null,
      kind,
      title,
      body,
      priority,
      source_table: sourceTable,
      source_id: sourceId,
      recipient_ids: recipientIds,
      include_actor: includeActor,
      url: '/',
    }

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) throw new Error('Sessione scaduta: rifai il login per inviare notifiche.')

      const { data: result, error } = await supabase.functions.invoke('send-push-notification', {
        body: payload,
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (error) throw error
      if (result?.error) throw new Error(result.error)
      if (!silentIfNoRecipients && Number(result?.recipients || 0) > 0 && Number(result?.push_sent || 0) === 0) {
        showToast('Notifica creata, ma nessun dispositivo ha ricevuto la push. Premi 📲 su ogni telefono e ricontrolla i secrets VAPID.')
      }
      return result
    } catch (error) {
      console.warn('Push non inviata:', error)
      showToast(`Notifica push non inviata: ${error.message || 'controlla configurazione Supabase/Vercel'}`)
      return null
    }
  }

  function handleRealtimeChange(table, payload) {
    if (payload.eventType !== 'INSERT') return

    const row = payload.new || {}
    if (!row.created_by || row.created_by === user?.id) return

    const tableInfo = NOTIFICATION_TABLES[table]
    if (!tableInfo) return

    const author = membersRef.current.find((m) => m.user_id === row.created_by)?.profile?.full_name || 'Un utente'
    const itemTitle = row[tableInfo.field] || row.title || 'Nuovo elemento'
    const notificationTitle = `${tableInfo.icon} ${author} ha aggiunto un ${tableInfo.label}`
    const body = String(itemTitle).slice(0, 120)

    showToast(`${author} ha aggiunto: ${body}`)

    // Se le push vere non sono ancora configurate, usiamo una notifica locale come fallback mentre l'app è aperta.
    if (!import.meta.env.VITE_VAPID_PUBLIC_KEY && getNotificationPermission() === 'granted') {
      showBrowserNotification(notificationTitle, {
        body,
        icon: '/image/icon.png',
        badge: '/image/icon.png',
        tag: `${table}-${row.id}`,
        data: { url: '/' },
      }).catch(() => {})
    }
  }

  async function ensureProfileAndSpaces(currentUser) {
    setWorkspaceLoading(true)
    const defaultName = currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'Utente Orchidea'

    try {
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .maybeSingle()

      if (!existingProfile) {
        const { data: newProfile, error } = await supabase
          .from('profiles')
          .insert({ id: currentUser.id, full_name: defaultName, email: currentUser.email })
          .select()
          .single()

        if (error) showToast(error.message)
        setProfile(newProfile || { id: currentUser.id, full_name: defaultName })
      } else {
        setProfile(existingProfile)
        if (existingProfile.email !== currentUser.email) {
          await supabase.from('profiles').update({ email: currentUser.email }).eq('id', currentUser.id)
        }
      }

      await loadSpaces(currentUser.id)
    } finally {
      setWorkspaceLoading(false)
    }
  }

  async function loadSpaces(userId = user?.id) {
    if (!userId) return
    const { data: rows, error } = await supabase
      .from('space_members')
      .select('role, spaces(*)')
      .eq('user_id', userId)
      .order('joined_at', { ascending: true })

    if (error) {
      showToast(error.message)
      return
    }

    const mapped = (rows || [])
      .filter((row) => row.spaces)
      .map((row) => ({ ...row.spaces, member_role: row.role }))

    setSpaces(mapped)
    setCurrentSpace((old) => old?.id ? mapped.find((s) => s.id === old.id) || mapped[0] || null : mapped[0] || null)
  }

  async function loadAll(spaceId) {
    setRefreshing(true)

    const [tasks, events, notes, lists, documents, expenses, announcements, members] = await Promise.all([
      supabase.from('tasks').select('*').eq('space_id', spaceId).order('created_at', { ascending: false }),
      supabase.from('events').select('*').eq('space_id', spaceId).order('starts_at', { ascending: true }),
      supabase.from('notes').select('*').eq('space_id', spaceId).order('pinned', { ascending: false }).order('updated_at', { ascending: false }),
      supabase.from('lists').select('*, list_items(*)').eq('space_id', spaceId).order('created_at', { ascending: false }),
      supabase.from('documents').select('*').eq('space_id', spaceId).order('created_at', { ascending: false }),
      supabase.from('expenses').select('*').eq('space_id', spaceId).order('paid_at', { ascending: false }),
      supabase.from('announcements').select('*').eq('space_id', spaceId).order('created_at', { ascending: false }),
      supabase.from('space_members').select('*').eq('space_id', spaceId),
    ])

    const errors = [tasks, events, notes, lists, documents, expenses, announcements, members].map((r) => r.error).filter(Boolean)
    if (errors.length) showToast(errors[0].message)

    let membersWithProfiles = members.data || []
    const ids = membersWithProfiles.map((m) => m.user_id)
    if (ids.length) {
      const { data: profiles } = await supabase.from('profiles').select('*').in('id', ids)
      membersWithProfiles = membersWithProfiles.map((m) => ({
        ...m,
        profile: profiles?.find((p) => p.id === m.user_id) || null,
      }))
    }

    setData({
      tasks: tasks.data || [],
      events: events.data || [],
      notes: notes.data || [],
      lists: (lists.data || []).map((l) => ({ ...l, list_items: [...(l.list_items || [])].sort((a, b) => Number(a.done) - Number(b.done)) })),
      documents: documents.data || [],
      expenses: expenses.data || [],
      announcements: announcements.data || [],
      members: membersWithProfiles,
    })
    setRefreshing(false)
  }

  const helpers = {
    user,
    profile,
    currentSpace,
    data,
    showToast,
    loadAll: () => currentSpace?.id && loadAll(currentSpace.id),
    memberName: (id) => data.members.find((m) => m.user_id === id)?.profile?.full_name || 'Non assegnato',
    requestNotifications,
    notificationPermission,
    sendPushNotification,
  }

  const unreadCount = notifications.filter((n) => !n.read_at).length

  if (loading) return <Splash text="Carico Orchidea Organizer…" />
  if (missingEnv) return <SetupMissing />
  if (!session) return <AuthScreen />
  if (workspaceLoading) return <Splash text="Apro il tuo spazio Orchidea…" />
  if (!currentSpace) return <Onboarding user={user} onDone={() => loadSpaces(user.id)} showToast={showToast} />

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.png" alt="Orchidea" />
          <div>
            <strong>Orchidea</strong>
            <span>Organizer</span>
          </div>
        </div>

        <div className="space-switcher">
          <label>Spazio</label>
          <select value={currentSpace.id} onChange={(e) => setCurrentSpace(spaces.find((s) => s.id === e.target.value))}>
            {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>
        </div>

        <nav>
          {TABS.map((tab) => (
            <button key={tab.id} className={active === tab.id ? 'active' : ''} onClick={() => setActive(tab.id)}>
              <span>{tab.icon}</span>{tab.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">{currentSpace.name}</p>
            <h1>{TABS.find((t) => t.id === active)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <span className={`sync-dot ${refreshing ? 'loading' : ''}`}></span>
            <div className="notification-wrap">
              <button className="notify-toggle enabled" onClick={() => setNotificationsOpen((v) => !v)} title="Apri notifiche">
                🔔{unreadCount > 0 && <span className="notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
              </button>
              {notificationsOpen && (
                <NotificationPanel
                  notifications={notifications}
                  onClose={() => setNotificationsOpen(false)}
                  onMarkRead={markNotificationsRead}
                  onMarkOneRead={markNotificationRead}
                />
              )}
            </div>
            <button className={`notify-toggle ${notificationPermission === 'granted' ? 'enabled' : ''}`} onClick={requestNotifications} title={notificationPermission === 'granted' ? 'Invia notifica di test' : 'Attiva notifiche push'}>
              {notificationPermission === 'granted' ? '📲' : '🔕'}
            </button>
            <button className="ghost" onClick={() => loadAll(currentSpace.id)}>Aggiorna</button>
            <div className="avatar">{(profile?.full_name || user.email || 'O').slice(0, 1).toUpperCase()}</div>
          </div>
        </header>

        {pushStatus && <div className="push-status">{pushStatus}</div>}

        <div className="mobile-tabs">
          {TABS.map((tab) => (
            <button key={tab.id} className={active === tab.id ? 'active' : ''} onClick={() => setActive(tab.id)}>
              <span>{tab.icon}</span>{tab.label}
            </button>
          ))}
        </div>

        {active === 'dashboard' && <Dashboard {...helpers} setActive={setActive} />}
        {active === 'tasks' && <Tasks {...helpers} />}
        {active === 'calendar' && <Calendar {...helpers} />}
        {active === 'lists' && <Lists {...helpers} />}
        {active === 'notes' && <Notes {...helpers} />}
        {active === 'documents' && <Documents {...helpers} />}
        {active === 'budget' && <Budget {...helpers} />}
        {active === 'announcements' && <Announcements {...helpers} />}
        {active === 'chat' && <Chat {...helpers} />}
        {active === 'settings' && <Settings {...helpers} spaces={spaces} setCurrentSpace={setCurrentSpace} reloadSpaces={() => loadSpaces(user.id)} />}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function Splash({ text }) {
  return <div className="center-screen"><div className="loader"></div><h2>{text}</h2></div>
}

function SetupMissing() {
  return (
    <div className="center-screen setup-card">
      <img src="/logo.png" alt="Orchidea" />
      <h1>Collega Supabase</h1>
      <p>Mancano le variabili ambiente. Crea il file <code>.env</code> partendo da <code>.env.example</code>.</p>
      <pre>{`VITE_SUPABASE_URL=https://...
VITE_SUPABASE_ANON_KEY=...`}</pre>
    </div>
  )
}

function getAuthRedirectUrl() {
  const configuredUrl = import.meta.env.VITE_APP_URL?.trim()
  const baseUrl = configuredUrl || (typeof window !== 'undefined' ? window.location.origin : '')
  return baseUrl.replace(/\/+$/, '')
}

function AuthScreen() {
  const [mode, setMode] = useState('login')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [signupPin, setSignupPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setMessage('')

    const action = mode === 'login'
      ? supabase.auth.signInWithPassword({ email, password })
      : supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${getAuthRedirectUrl()}/`,
            data: {
              full_name: fullName || email.split('@')[0],
              signup_pin: signupPin.trim(),
            },
          },
        })

    const { error } = await action
    if (error) {
      const isPinError = mode === 'signup' && /pin|database error saving new user/i.test(error.message)
      setMessage(isPinError ? 'PIN di registrazione non valido. Controlla il PIN e riprova.' : error.message)
    }
    else if (mode === 'signup') setMessage('Account creato. Se Supabase richiede conferma email, controlla la posta.')
    setBusy(false)
  }

  return (
    <div className="auth-screen">
      <section className="auth-hero">
        <img src="/logo.png" alt="Orchidea" />
        <span className="pill">Orchidea Organizer</span>
        <h1>Un posto unico per gestire il locale con Laura.</h1>
        <p>Attività, agenda, liste, note, documenti, budget e comunicazioni importanti in una bacheca condivisa stile FamilyWall, ma pensata per Orchidea.</p>
        <div className="hero-grid">
          <div>✅ Cose da fare</div>
          <div>📅 Calendario</div>
          <div>📂 Documenti</div>
          <div>💶 Budget</div>
        </div>
      </section>
      <section className="auth-card">
        <div className="auth-tabs">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Accedi</button>
          <button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>Registrati</button>
        </div>
        <form onSubmit={submit}>
          {mode === 'signup' && <Field label="Nome" value={fullName} onChange={setFullName} placeholder="Manuel / Laura" />}
          {mode === 'signup' && <Field label="PIN di registrazione" type="password" value={signupPin} onChange={setSignupPin} placeholder="PIN privato Orchidea" required inputMode="numeric" autoComplete="off" />}
          {mode === 'signup' && <p className="pin-hint">Solo chi conosce il PIN può creare un nuovo account. Senza PIN Supabase blocca la registrazione prima della conferma email.</p>}
          <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="nome@email.it" required />
          <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="Minimo 6 caratteri" required />
          <button className="primary" disabled={busy}>{busy ? 'Attendi…' : mode === 'login' ? 'Entra' : 'Crea account'}</button>
          {message && <p className="form-message">{message}</p>}
        </form>
      </section>
    </div>
  )
}

function Onboarding({ user, onDone, showToast }) {
  const [spaceName, setSpaceName] = useState('Orchidea')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)

  async function createSpace(e) {
    e.preventDefault()
    setBusy(true)

    // Creiamo spazio + proprietario con una funzione Supabase unica.
    // Così evitiamo il blocco RLS che può succedere quando il browser prova
    // a inserire lo spazio e leggerlo prima che esista la riga in space_members.
    const { error } = await supabase.rpc('create_space_with_owner', { space_name: spaceName })

    if (error) showToast(error.message)
    else onDone()
    setBusy(false)
  }

  async function joinSpace(e) {
    e.preventDefault()
    setBusy(true)
    const { error } = await supabase.rpc('join_space_by_code', { join_code: inviteCode })
    if (error) showToast(error.message)
    else onDone()
    setBusy(false)
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <img src="/logo.png" alt="Orchidea" />
        <h1>Configuriamo lo spazio condiviso</h1>
        <p>La prima persona crea lo spazio Orchidea. Chi arriva dopo entra con il codice invito.</p>

        <div className="onboarding-grid">
          <form onSubmit={createSpace} className="mini-panel">
            <h3>Crea spazio</h3>
            <Field label="Nome spazio" value={spaceName} onChange={setSpaceName} required />
            <button className="primary" disabled={busy}>Crea Orchidea</button>
          </form>
          <form onSubmit={joinSpace} className="mini-panel">
            <h3>Entra con codice</h3>
            <Field label="Codice invito" value={inviteCode} onChange={(v) => setInviteCode(v.toUpperCase())} placeholder="ORCH-ABC123" required />
            <button className="secondary" disabled={busy}>Entra nello spazio</button>
          </form>
        </div>
      </div>
    </div>
  )
}

function Dashboard({ data, memberName, setActive }) {
  const todo = data.tasks.filter((t) => t.status !== 'done')
  const today = todayISO()
  const todayEvents = data.events.filter((e) => e.starts_at?.slice(0, 10) === today)
  const urgent = todo.filter((t) => ['alta', 'urgente'].includes(t.priority)).slice(0, 4)
  const totalMonth = data.expenses
    .filter((e) => e.paid_at?.slice(0, 7) === today.slice(0, 7))
    .reduce((sum, e) => sum + Number(e.amount || 0), 0)

  return (
    <div className="page-grid">
      <section className="hero-card big-span">
        <div>
          <span className="pill">Bacheca operativa</span>
          <h2>Oggi in Orchidea</h2>
          <p>Qui tenete insieme tutto: cose da comprare, lavori da fare, documenti, scadenze, serate e appunti al volo.</p>
        </div>
        <div className="hero-actions">
          <button onClick={() => setActive('tasks')}>Nuova attività</button>
          <button onClick={() => setActive('calendar')}>Apri agenda</button>
        </div>
      </section>

      <StatCard title="Attività aperte" value={todo.length} note="Da completare" icon="✅" />
      <StatCard title="Eventi oggi" value={todayEvents.length} note="In agenda" icon="📅" />
      <StatCard title="Documenti" value={data.documents.length} note="Caricati" icon="📂" />
      <StatCard title="Spese mese" value={money(totalMonth)} note="Registrate" icon="💶" />

      <Panel title="Comunicazioni importanti" action={<button onClick={() => setActive('announcements')}>Apri</button>}>
        <div className="stack-list">
          {data.announcements.slice(0, 4).map((a) => <AnnouncementItem key={a.id} item={a} />)}
          {!data.announcements.length && <Empty text="Nessuna comunicazione inserita." />}
        </div>
      </Panel>

      <Panel title="Priorità" action={<button onClick={() => setActive('tasks')}>Vedi tutte</button>}>
        <div className="stack-list">
          {urgent.map((t) => <TaskMini key={t.id} task={t} memberName={memberName} />)}
          {!urgent.length && <Empty text="Niente urgenze. Miracolo raro, godiamocelo." />}
        </div>
      </Panel>

      <Panel title="Agenda di oggi" action={<button onClick={() => setActive('calendar')}>Calendario</button>}>
        <div className="stack-list">
          {todayEvents.map((e) => <EventMini key={e.id} event={e} />)}
          {!todayEvents.length && <Empty text="Nessun evento per oggi." />}
        </div>
      </Panel>
    </div>
  )
}

function Tasks({ currentSpace, data, showToast, loadAll, memberName, sendPushNotification }) {
  const emptyTask = { title: '', description: '', priority: 'media', due_date: '', assigned_to: '' }
  const [form, setForm] = useState(emptyTask)
  const [formOpen, setFormOpen] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState(null)

  const isEditing = Boolean(editingTaskId)

  function openNewTask() {
    setEditingTaskId(null)
    setForm(emptyTask)
    setFormOpen(true)
  }

  function closeTaskForm() {
    setEditingTaskId(null)
    setForm(emptyTask)
    setFormOpen(false)
  }

  function editTask(task) {
    setEditingTaskId(task.id)
    setForm({
      title: task.title || '',
      description: task.description || '',
      priority: task.priority || 'media',
      due_date: task.due_date || '',
      assigned_to: task.assigned_to || '',
    })
    setFormOpen(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function saveTask(e) {
    e.preventDefault()
    const payload = {
      title: form.title.trim(),
      description: form.description || '',
      priority: form.priority,
      assigned_to: form.assigned_to || null,
      due_date: form.due_date || null,
    }

    if (!payload.title) return

    if (isEditing) {
      const { error } = await supabase.from('tasks').update(payload).eq('id', editingTaskId)
      if (error) showToast(error.message)
      else {
        showToast('Attività aggiornata')
        closeTaskForm()
        loadAll()
      }
      return
    }

    const { data: created, error } = await supabase
      .from('tasks')
      .insert({ ...payload, space_id: currentSpace.id, status: 'todo' })
      .select('id,title,priority')
      .single()

    if (error) showToast(error.message)
    else {
      closeTaskForm()
      sendPushNotification({ kind: 'task', title: 'Nuova attività Orchidea', body: created?.title || payload.title, priority: created?.priority || payload.priority, sourceTable: 'tasks', sourceId: created?.id })
      loadAll()
    }
  }

  async function patchTask(id, patch) {
    const { error } = await supabase.from('tasks').update(patch).eq('id', id)
    if (error) showToast(error.message)
    else loadAll()
  }

  async function deleteTask(id) {
    const { error } = await supabase.from('tasks').delete().eq('id', id)
    if (error) showToast(error.message)
    else {
      if (editingTaskId === id) closeTaskForm()
      loadAll()
    }
  }

  return (
    <div className="work-area">
      <FormLauncher
        open={formOpen}
        title={isEditing ? 'Modifica attività' : 'Nuova attività'}
        description={isEditing ? 'Aggiorna titolo, priorità, scadenza o assegnazione senza ricrearla.' : 'Aggiungi una cosa da fare solo quando ti serve, così la bacheca resta pulita.'}
        buttonLabel="+ Nuova attività"
        openLabel="Chiudi"
        onOpen={openNewTask}
        onClose={closeTaskForm}
      >
        <form className="composer embedded" onSubmit={saveTask}>
          <div className="composer-main">
            <Field label="Cosa da fare" value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="Es. chiamare SIAE, comprare ghiaccio, sistemare luci..." required />
            <Field label="Note" value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="Dettagli veloci" />
          </div>
          <div className="composer-side">
            <Select label="Priorità" value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} options={['bassa','media','alta','urgente']} />
            <Field label="Scadenza" type="date" value={form.due_date} onChange={(v) => setForm({ ...form, due_date: v })} />
            <MemberSelect label="Assegna a" members={data.members} value={form.assigned_to} onChange={(v) => setForm({ ...form, assigned_to: v })} />
            <div className="form-actions span-2">
              <button type="button" className="ghost" onClick={closeTaskForm}>Annulla</button>
              <button className="primary">{isEditing ? 'Salva modifiche' : 'Aggiungi'}</button>
            </div>
          </div>
        </form>
      </FormLauncher>

      <div className="kanban">
        {[
          ['todo', 'Da fare'],
          ['doing', 'In corso'],
          ['done', 'Fatto'],
        ].map(([status, title]) => (
          <section key={status} className="kanban-column">
            <h3>{title}<span>{data.tasks.filter((t) => t.status === status).length}</span></h3>
            {data.tasks.filter((t) => t.status === status).map((task) => (
              <article key={task.id} className={`task-card priority-${task.priority}`}>
                <div className="task-head">
                  <strong>{task.title}</strong>
                  <div className="icon-actions">
                    <button className="icon-btn" title="Modifica attività" onClick={() => editTask(task)}>✎</button>
                    <button className="icon-btn" title="Elimina attività" onClick={() => deleteTask(task.id)}>×</button>
                  </div>
                </div>
                {task.description && <p>{task.description}</p>}
                <div className="meta-row">
                  <span className={`priority-chip priority-chip-${task.priority}`}>{task.priority}</span>
                  {task.due_date && <span className="date-chip">{fmtDate(task.due_date)}</span>}
                </div>
                <div className="task-footer">
                  <small>{memberName(task.assigned_to)}</small>
                  <select value={task.status} onChange={(e) => patchTask(task.id, { status: e.target.value })}>
                    <option value="todo">Da fare</option>
                    <option value="doing">In corso</option>
                    <option value="done">Fatto</option>
                  </select>
                </div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

function Calendar({ currentSpace, data, showToast, loadAll, sendPushNotification }) {
  const initialForm = { title: '', starts_at: `${todayISO()}T21:30`, ends_at: '', location: '', category: 'generale', notes: '' }
  const [form, setForm] = useState(initialForm)
  const [formOpen, setFormOpen] = useState(false)
  const [editingEventId, setEditingEventId] = useState(null)
  const [filterDay, setFilterDay] = useState('')

  const isEditing = Boolean(editingEventId)

  const events = useMemo(() => {
    const base = filterDay ? data.events.filter((e) => e.starts_at?.slice(0, 10) === filterDay) : data.events
    return base.slice().sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
  }, [data.events, filterDay])

  function openNewEvent() {
    setEditingEventId(null)
    setForm(initialForm)
    setFormOpen(true)
  }

  function closeEventForm() {
    setEditingEventId(null)
    setForm(initialForm)
    setFormOpen(false)
  }

  function editEvent(event) {
    setEditingEventId(event.id)
    setForm({
      title: event.title || '',
      starts_at: event.starts_at ? event.starts_at.slice(0, 16) : `${todayISO()}T21:30`,
      ends_at: event.ends_at ? event.ends_at.slice(0, 16) : '',
      location: event.location || '',
      category: event.category || 'generale',
      notes: event.notes || '',
    })
    setFormOpen(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function saveEvent(e) {
    e.preventDefault()
    const payload = {
      title: form.title.trim(),
      starts_at: form.starts_at,
      ends_at: form.ends_at || null,
      location: form.location || '',
      category: form.category || 'generale',
      notes: form.notes || '',
    }

    if (!payload.title || !payload.starts_at) return

    if (isEditing) {
      const { error } = await supabase.from('events').update(payload).eq('id', editingEventId)
      if (error) showToast(error.message)
      else {
        showToast('Evento aggiornato')
        closeEventForm()
        loadAll()
      }
      return
    }

    const { data: created, error } = await supabase
      .from('events')
      .insert({ ...payload, space_id: currentSpace.id })
      .select('id,title')
      .single()

    if (error) showToast(error.message)
    else {
      closeEventForm()
      sendPushNotification({ kind: 'event', title: 'Nuovo evento in agenda', body: created?.title || form.title, sourceTable: 'events', sourceId: created?.id })
      loadAll()
    }
  }

  async function deleteEvent(id) {
    const { error } = await supabase.from('events').delete().eq('id', id)
    if (error) showToast(error.message)
    else {
      if (editingEventId === id) closeEventForm()
      loadAll()
    }
  }

  return (
    <div className="work-area">
      <FormLauncher
        open={formOpen}
        title={isEditing ? 'Modifica evento' : 'Nuovo evento'}
        description={isEditing ? 'Aggiorna data, orario, luogo, categoria e note senza ricreare l’evento.' : 'Apri il modulo solo quando devi inserire una serata, una scadenza o una riunione.'}
        buttonLabel="+ Nuovo evento"
        openLabel="Chiudi"
        onOpen={openNewEvent}
        onClose={closeEventForm}
      >
        <form className="panel-form" onSubmit={saveEvent}>
          <Field label="Titolo" value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="Serata, scadenza, riunione..." required />
          <div className="form-grid two-fields">
            <Field label="Inizio" type="datetime-local" value={form.starts_at} onChange={(v) => setForm({ ...form, starts_at: v })} required />
            <Field label="Fine" type="datetime-local" value={form.ends_at} onChange={(v) => setForm({ ...form, ends_at: v })} />
          </div>
          <div className="form-grid two-fields">
            <Field label="Luogo" value={form.location} onChange={(v) => setForm({ ...form, location: v })} placeholder="Orchidea / estivo / online" />
            <Field label="Categoria" value={form.category} onChange={(v) => setForm({ ...form, category: v })} placeholder="serata, corsi, scadenza..." />
          </div>
          <Textarea label="Note" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
          <div className="form-actions">
            <button type="button" className="ghost" onClick={closeEventForm}>Annulla</button>
            <button className="primary">{isEditing ? 'Salva modifiche' : 'Salva evento'}</button>
          </div>
        </form>
      </FormLauncher>

      <section className="panel content-panel">
        <div className="panel-head">
          <h2>Agenda condivisa</h2>
          <input type="date" value={filterDay} onChange={(e) => setFilterDay(e.target.value)} />
        </div>
        <div className="timeline">
          {events.map((event) => (
            <article key={event.id} className="timeline-item">
              <div className="timeline-date"><strong>{fmtDateTime(event.starts_at)}</strong><span>{event.category}</span></div>
              <div>
                <h3>{event.title}</h3>
                {event.ends_at && <p>🕒 Fine: {fmtDateTime(event.ends_at)}</p>}
                {event.location && <p>📍 {event.location}</p>}
                {event.notes && <p>{event.notes}</p>}
              </div>
              <div className="icon-actions timeline-actions">
                <button className="icon-btn" title="Modifica evento" onClick={() => editEvent(event)}>✎</button>
                <button className="icon-btn" title="Elimina evento" onClick={() => deleteEvent(event.id)}>×</button>
              </div>
            </article>
          ))}
          {!events.length && <Empty text="Agenda vuota per questo filtro." />}
        </div>
      </section>
    </div>
  )
}

function Lists({ currentSpace, data, showToast, loadAll, memberName, sendPushNotification }) {
  const [title, setTitle] = useState('')
  const [type, setType] = useState('operativa')
  const [formOpen, setFormOpen] = useState(false)
  const [newItems, setNewItems] = useState({})

  async function createList(e) {
    e.preventDefault()
    const { data: created, error } = await supabase.from('lists').insert({ title, type, space_id: currentSpace.id }).select('id,title').single()
    if (error) showToast(error.message)
    else {
      setTitle('')
      setType('operativa')
      setFormOpen(false)
      sendPushNotification({ kind: 'list', title: 'Nuova lista Orchidea', body: created?.title || title, sourceTable: 'lists', sourceId: created?.id })
      loadAll()
    }
  }

  async function addItem(listId) {
    const label = newItems[listId]?.trim()
    if (!label) return
    const { error } = await supabase.from('list_items').insert({ list_id: listId, label })
    if (error) showToast(error.message)
    else {
      setNewItems({ ...newItems, [listId]: '' })
      loadAll()
    }
  }

  async function toggleItem(item) {
    const { error } = await supabase.from('list_items').update({ done: !item.done }).eq('id', item.id)
    if (error) showToast(error.message)
    else loadAll()
  }

  async function deleteItem(id) {
    const { error } = await supabase.from('list_items').delete().eq('id', id)
    if (error) showToast(error.message)
    else loadAll()
  }

  async function deleteList(id) {
    const { error } = await supabase.from('lists').delete().eq('id', id)
    if (error) showToast(error.message)
    else loadAll()
  }

  return (
    <div className="work-area">
      <FormLauncher
        open={formOpen}
        title="Nuova lista"
        description="Liste per spesa, lavori, idee eventi o materiali da controllare."
        buttonLabel="+ Nuova lista"
        openLabel="Chiudi"
        onOpen={() => setFormOpen(true)}
        onClose={() => setFormOpen(false)}
      >
        <form className="composer compact embedded" onSubmit={createList}>
          <Field label="Titolo lista" value={title} onChange={setTitle} placeholder="Es. Spesa bar, lavori da fare, idee eventi..." required />
          <Field label="Tipo" value={type} onChange={setType} placeholder="operativa / acquisti / idee" />
          <div className="form-actions compact-actions">
            <button type="button" className="ghost" onClick={() => setFormOpen(false)}>Annulla</button>
            <button className="primary">Crea lista</button>
          </div>
        </form>
      </FormLauncher>

      <div className="cards-grid">
        {data.lists.map((list) => (
          <article key={list.id} className="list-card">
            <div className="task-head">
              <div><h3>{list.title}</h3><span className="tag">{list.type}</span></div>
              <button className="icon-btn" onClick={() => deleteList(list.id)}>×</button>
            </div>
            <div className="add-line">
              <input value={newItems[list.id] || ''} onChange={(e) => setNewItems({ ...newItems, [list.id]: e.target.value })} placeholder="Aggiungi voce" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(list.id) } }} />
              <button onClick={() => addItem(list.id)}>+</button>
            </div>
            <div className="check-list">
              {list.list_items?.map((item) => (
                <div key={item.id} className={item.done ? 'done' : ''}>
                  <label><input type="checkbox" checked={item.done} onChange={() => toggleItem(item)} />{item.label}</label>
                  <small>{item.assigned_to ? memberName(item.assigned_to) : ''}</small>
                  <button onClick={() => deleteItem(item.id)}>×</button>
                </div>
              ))}
            </div>
          </article>
        ))}
        {!data.lists.length && <Empty text="Crea la prima lista condivisa." />}
      </div>
    </div>
  )
}

function Notes({ currentSpace, data, showToast, loadAll, sendPushNotification }) {
  const [form, setForm] = useState({ title: '', folder: 'Generale', content: '', pinned: false })
  const [formOpen, setFormOpen] = useState(false)
  const [filter, setFilter] = useState('Tutte')
  const folders = ['Tutte', ...Array.from(new Set(data.notes.map((n) => n.folder || 'Generale')))]
  const notes = filter === 'Tutte' ? data.notes : data.notes.filter((n) => n.folder === filter)

  async function addNote(e) {
    e.preventDefault()
    const { data: created, error } = await supabase.from('notes').insert({ ...form, space_id: currentSpace.id }).select('id,title').single()
    if (error) showToast(error.message)
    else {
      setForm({ title: '', folder: 'Generale', content: '', pinned: false })
      setFormOpen(false)
      sendPushNotification({ kind: 'note', title: 'Nuova nota Orchidea', body: created?.title || form.title, sourceTable: 'notes', sourceId: created?.id })
      loadAll()
    }
  }

  async function togglePin(note) {
    const { error } = await supabase.from('notes').update({ pinned: !note.pinned }).eq('id', note.id)
    if (error) showToast(error.message)
    else loadAll()
  }

  async function deleteNote(id) {
    const { error } = await supabase.from('notes').delete().eq('id', id)
    if (error) showToast(error.message)
    else loadAll()
  }

  return (
    <div className="work-area">
      <FormLauncher
        open={formOpen}
        title="Nuova nota"
        description="Scrivi appunti e fissali in alto solo quando serve."
        buttonLabel="+ Nuova nota"
        openLabel="Chiudi"
        onOpen={() => setFormOpen(true)}
        onClose={() => setFormOpen(false)}
      >
        <form className="panel-form" onSubmit={addNote}>
          <div className="form-grid two-fields">
            <Field label="Titolo" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required />
            <Field label="Cartella" value={form.folder} onChange={(v) => setForm({ ...form, folder: v })} placeholder="Es. Estivo, Fornitori, Idee..." />
          </div>
          <Textarea label="Contenuto" value={form.content} onChange={(v) => setForm({ ...form, content: v })} />
          <label className="switch-line"><input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} /> Fissa in alto</label>
          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setFormOpen(false)}>Annulla</button>
            <button className="primary">Salva nota</button>
          </div>
        </form>
      </FormLauncher>

      <section className="panel content-panel">
        <div className="folder-tabs">
          {folders.map((folder) => <button key={folder} className={filter === folder ? 'active' : ''} onClick={() => setFilter(folder)}>{folder}</button>)}
        </div>
        <div className="notes-grid">
          {notes.map((note) => (
            <article key={note.id} className={note.pinned ? 'note-card pinned' : 'note-card'}>
              <div className="task-head">
                <span className="tag">{note.folder}</span>
                <button className="icon-btn" onClick={() => deleteNote(note.id)}>×</button>
              </div>
              <h3>{note.pinned ? '📌 ' : ''}{note.title}</h3>
              <p>{note.content}</p>
              <button className="ghost" onClick={() => togglePin(note)}>{note.pinned ? 'Togli fissato' : 'Fissa'}</button>
            </article>
          ))}
          {!notes.length && <Empty text="Nessuna nota in questa cartella." />}
        </div>
      </section>
    </div>
  )
}

function Documents({ currentSpace, data, showToast, loadAll, sendPushNotification }) {
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('Documenti')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)

  async function uploadDocument(e) {
    e.preventDefault()
    if (!file) {
      showToast('Seleziona un file da caricare')
      return
    }

    setBusy(true)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${currentSpace.id}/${Date.now()}_${safeName}`

    const { error: uploadError } = await supabase.storage
      .from('orchidea-documents')
      .upload(path, file, { cacheControl: '3600', upsert: false })

    if (uploadError) {
      showToast(uploadError.message)
      setBusy(false)
      return
    }

    const { data: created, error } = await supabase.from('documents').insert({
      space_id: currentSpace.id,
      title: title || file.name,
      category,
      notes,
      file_path: path,
      file_name: file.name,
      file_size: file.size,
    }).select('id,title').single()

    if (error) showToast(error.message)
    else {
      setTitle('')
      setCategory('Documenti')
      setNotes('')
      setFile(null)
      e.target.reset()
      setFormOpen(false)
      sendPushNotification({ kind: 'document', title: 'Nuovo documento caricato', body: created?.title || title || file.name, sourceTable: 'documents', sourceId: created?.id })
      loadAll()
    }
    setBusy(false)
  }

  async function openDocument(doc) {
    if (!doc.file_path) return
    const { data: signed, error } = await supabase.storage
      .from('orchidea-documents')
      .createSignedUrl(doc.file_path, 60)

    if (error) showToast(error.message)
    else window.open(signed.signedUrl, '_blank', 'noopener,noreferrer')
  }

  async function deleteDocument(doc) {
    if (doc.file_path) await supabase.storage.from('orchidea-documents').remove([doc.file_path])
    const { error } = await supabase.from('documents').delete().eq('id', doc.id)
    if (error) showToast(error.message)
    else loadAll()
  }

  return (
    <div className="work-area">
      <FormLauncher
        open={formOpen}
        title="Carica documento"
        description="Contratti, preventivi, SIAE o file utili restano ordinati nella sezione documenti."
        buttonLabel="+ Nuovo documento"
        openLabel="Chiudi"
        onOpen={() => setFormOpen(true)}
        onClose={() => setFormOpen(false)}
      >
        <form className="panel-form" onSubmit={uploadDocument}>
          <div className="form-grid two-fields">
            <Field label="Titolo" value={title} onChange={setTitle} placeholder="Contratto, preventivo, SIAE..." />
            <Field label="Categoria" value={category} onChange={setCategory} />
          </div>
          <Textarea label="Note" value={notes} onChange={setNotes} />
          <label className="field"><span>File</span><input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setFormOpen(false)}>Annulla</button>
            <button className="primary" disabled={busy}>{busy ? 'Carico…' : 'Carica'}</button>
          </div>
        </form>
      </FormLauncher>

      <section className="panel content-panel">
        <div className="documents-grid">
          {data.documents.map((doc) => (
            <article key={doc.id} className="doc-card">
              <div className="doc-icon">📄</div>
              <div>
                <span className="tag">{doc.category}</span>
                <h3>{doc.title}</h3>
                <p>{doc.notes || doc.file_name}</p>
                <small>{doc.file_size ? `${Math.round(doc.file_size / 1024)} KB` : ''} · {fmtDate(doc.created_at)}</small>
              </div>
              <div className="doc-actions">
                <button onClick={() => openDocument(doc)}>Apri</button>
                <button className="danger" onClick={() => deleteDocument(doc)}>Elimina</button>
              </div>
            </article>
          ))}
          {!data.documents.length && <Empty text="Ancora nessun documento caricato." />}
        </div>
      </section>
    </div>
  )
}

function Budget({ currentSpace, data, showToast, loadAll, memberName, sendPushNotification }) {
  const [form, setForm] = useState({ title: '', amount: '', category: 'generale', paid_by: '', paid_at: todayISO(), notes: '' })
  const [formOpen, setFormOpen] = useState(false)
  const total = data.expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0)
  const month = todayISO().slice(0, 7)
  const monthTotal = data.expenses.filter((e) => e.paid_at?.slice(0, 7) === month).reduce((sum, e) => sum + Number(e.amount || 0), 0)

  async function addExpense(e) {
    e.preventDefault()
    const { data: created, error } = await supabase.from('expenses').insert({ ...form, amount: Number(form.amount || 0), paid_by: form.paid_by || null, space_id: currentSpace.id }).select('id,title,amount').single()
    if (error) showToast(error.message)
    else {
      setForm({ title: '', amount: '', category: 'generale', paid_by: '', paid_at: todayISO(), notes: '' })
      setFormOpen(false)
      sendPushNotification({ kind: 'expense', title: 'Nuova spesa registrata', body: `${created?.title || form.title} · ${money(created?.amount || form.amount)}`, sourceTable: 'expenses', sourceId: created?.id })
      loadAll()
    }
  }

  async function deleteExpense(id) {
    const { error } = await supabase.from('expenses').delete().eq('id', id)
    if (error) showToast(error.message)
    else loadAll()
  }

  return (
    <div className="work-area">
      <FormLauncher
        open={formOpen}
        title="Nuova spesa"
        description="Registra le spese solo quando serve e lascia visibili subito i totali."
        buttonLabel="+ Nuova spesa"
        openLabel="Chiudi"
        onOpen={() => setFormOpen(true)}
        onClose={() => setFormOpen(false)}
      >
        <form className="panel-form" onSubmit={addExpense}>
          <div className="form-grid two-fields">
            <Field label="Titolo" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required />
            <Field label="Importo" type="number" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} required />
          </div>
          <div className="form-grid three-fields">
            <Field label="Categoria" value={form.category} onChange={(v) => setForm({ ...form, category: v })} />
            <Field label="Data" type="date" value={form.paid_at} onChange={(v) => setForm({ ...form, paid_at: v })} />
            <MemberSelect label="Pagato da" members={data.members} value={form.paid_by} onChange={(v) => setForm({ ...form, paid_by: v })} />
          </div>
          <Textarea label="Note" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setFormOpen(false)}>Annulla</button>
            <button className="primary">Registra</button>
          </div>
        </form>
      </FormLauncher>

      <section className="panel content-panel">
        <div className="budget-stats">
          <StatCard title="Totale storico" value={money(total)} note="Tutte le spese" icon="💶" />
          <StatCard title="Questo mese" value={money(monthTotal)} note="Spese mese corrente" icon="📆" />
        </div>
        <div className="table-list">
          {data.expenses.map((expense) => (
            <div key={expense.id} className="table-row">
              <div><strong>{expense.title}</strong><span>{expense.category} · {fmtDate(expense.paid_at)} · {memberName(expense.paid_by)}</span></div>
              <b>{money(expense.amount)}</b>
              <button className="icon-btn" onClick={() => deleteExpense(expense.id)}>×</button>
            </div>
          ))}
          {!data.expenses.length && <Empty text="Nessuna spesa registrata." />}
        </div>
      </section>
    </div>
  )
}

function Announcements({ currentSpace, data, showToast, loadAll, sendPushNotification }) {
  const [form, setForm] = useState({ title: '', body: '', importance: 'normale' })
  const [formOpen, setFormOpen] = useState(false)

  async function addAnnouncement(e) {
    e.preventDefault()
    const { data: created, error } = await supabase.from('announcements').insert({ ...form, space_id: currentSpace.id }).select('id,title,importance').single()
    if (error) showToast(error.message)
    else {
      setForm({ title: '', body: '', importance: 'normale' })
      setFormOpen(false)
      sendPushNotification({ kind: 'announcement', title: form.importance === 'urgente' ? 'Comunicazione URGENTE' : 'Nuova comunicazione', body: created?.title || form.title, priority: form.importance, sourceTable: 'announcements', sourceId: created?.id })
      loadAll()
    }
  }

  async function deleteAnnouncement(id) {
    const { error } = await supabase.from('announcements').delete().eq('id', id)
    if (error) showToast(error.message)
    else loadAll()
  }

  return (
    <div className="work-area">
      <FormLauncher
        open={formOpen}
        title="Nuova comunicazione"
        description="Messaggi importanti per il team senza tenere il modulo sempre aperto."
        buttonLabel="+ Nuovo messaggio"
        openLabel="Chiudi"
        onOpen={() => setFormOpen(true)}
        onClose={() => setFormOpen(false)}
      >
        <form className="panel-form" onSubmit={addAnnouncement}>
          <div className="form-grid two-fields">
            <Field label="Titolo" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required />
            <Select label="Importanza" value={form.importance} onChange={(v) => setForm({ ...form, importance: v })} options={['normale','importante','urgente']} />
          </div>
          <Textarea label="Messaggio" value={form.body} onChange={(v) => setForm({ ...form, body: v })} />
          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setFormOpen(false)}>Annulla</button>
            <button className="primary">Pubblica</button>
          </div>
        </form>
      </FormLauncher>

      <section className="panel wall-feed content-panel">
        {data.announcements.map((item) => (
          <article key={item.id} className={`announcement importance-${item.importance}`}>
            <div className="task-head">
              <span className={`tag importance-tag importance-${item.importance}`}>{item.importance}</span>
              <button className="icon-btn" onClick={() => deleteAnnouncement(item.id)}>×</button>
            </div>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            <small>{fmtDateTime(item.created_at)}</small>
          </article>
        ))}
        {!data.announcements.length && <Empty text="Qui puoi lasciare comunicazioni importanti per il team." />}
      </section>
    </div>
  )
}


function NotificationPanel({ notifications, onClose, onMarkRead, onMarkOneRead }) {
  const unreadCount = notifications.filter((n) => !n.read_at).length

  return (
    <div className="notification-panel" role="dialog" aria-label="Notifiche Orchidea">
      <div className="notification-panel-header">
        <div>
          <h3>Notifiche</h3>
          <span>{unreadCount ? `${unreadCount} da leggere` : 'Tutto letto'}</span>
        </div>
        <button className="notification-close" onClick={onClose} aria-label="Chiudi notifiche">×</button>
      </div>

      <div className="notification-panel-toolbar">
        <button className="notification-read-all" onClick={onMarkRead} disabled={!unreadCount}>
          ✓ Segna tutte come lette
        </button>
      </div>

      <div className="notification-list">
        {notifications.slice(0, 20).map((n) => (
          <article key={n.id} className={n.read_at ? 'notification-item' : 'notification-item unread'}>
            <div className="notification-item-main">
              <strong>{n.title}</strong>
              {n.body && <p>{n.body}</p>}
              <small>{fmtDateTime(n.created_at)}</small>
            </div>
            {!n.read_at && (
              <button className="notification-mark-one" onClick={() => onMarkOneRead(n.id)}>
                Segna letta
              </button>
            )}
          </article>
        ))}
        {!notifications.length && <Empty text="Nessuna notifica per ora." />}
      </div>
    </div>
  )
}

function Chat({ user, profile, showToast, sendPushNotification }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [incoming, setIncoming] = useState([])
  const [outgoing, setOutgoing] = useState([])
  const [chats, setChats] = useState([])
  const [selectedChat, setSelectedChat] = useState(null)
  const [messages, setMessages] = useState([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)

  useEffect(() => {
    loadChatData()
  }, [user?.id])

  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setResults([])
      return
    }
    const t = window.setTimeout(searchUsers, 350)
    return () => window.clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (!selectedChat?.id) {
      setMessages([])
      return
    }
    loadMessages(selectedChat)
    const channel = supabase.channel(`chat-${selectedChat.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'direct_messages',
        filter: `chat_id=eq.${selectedChat.id}`,
      }, (payload) => {
        setMessages((prev) => prev.some((m) => m.id === payload.new.id) ? prev : [...prev, payload.new])
        if (payload.new.sender_id !== user.id) showToast('Nuovo messaggio in chat')
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [selectedChat?.id, user?.id])

  async function profilesByIds(ids) {
    const clean = Array.from(new Set(ids.filter(Boolean)))
    if (!clean.length) return []
    const { data } = await supabase.from('profiles').select('id,full_name,email').in('id', clean)
    return data || []
  }

  async function loadChatData() {
    if (!user?.id) return
    const [{ data: requests, error: reqError }, { data: rawChats, error: chatError }] = await Promise.all([
      supabase.from('contact_requests').select('*').or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`).order('created_at', { ascending: false }),
      supabase.from('direct_chats').select('*').or(`user_a.eq.${user.id},user_b.eq.${user.id}`).order('updated_at', { ascending: false }),
    ])

    if (reqError || chatError) {
      showToast(reqError?.message || chatError?.message || 'Errore caricamento chat')
      return
    }

    const reqRows = requests || []
    const chatRows = rawChats || []
    const ids = [
      ...reqRows.flatMap((r) => [r.requester_id, r.recipient_id]),
      ...chatRows.flatMap((c) => [c.user_a, c.user_b]),
    ]
    const profiles = await profilesByIds(ids)
    const profileOf = (id) => profiles.find((p) => p.id === id) || null

    setIncoming(reqRows.filter((r) => r.recipient_id === user.id && r.status === 'pending').map((r) => ({ ...r, requester: profileOf(r.requester_id) })))
    setOutgoing(reqRows.filter((r) => r.requester_id === user.id && r.status === 'pending').map((r) => ({ ...r, recipient: profileOf(r.recipient_id) })))

    const mappedChats = chatRows.map((c) => {
      const otherId = c.user_a === user.id ? c.user_b : c.user_a
      return { ...c, other_id: otherId, other: profileOf(otherId) }
    })
    setChats(mappedChats)
    setSelectedChat((old) => old?.id ? mappedChats.find((c) => c.id === old.id) || mappedChats[0] || null : mappedChats[0] || null)
  }

  async function searchUsers() {
    const q = query.trim().replace(/[%,]/g, '')
    if (q.length < 2) return
    const { data, error } = await supabase
      .from('profiles')
      .select('id,full_name,email')
      .or(`full_name.ilike.%${q}%,email.ilike.%${q}%`)
      .neq('id', user.id)
      .limit(8)

    if (error) showToast(error.message)
    else setResults(data || [])
  }

  async function sendRequest(target) {
    setBusy(true)
    const { error } = await supabase.rpc('send_contact_request', { target_user_id: target.id })
    if (error) showToast(error.message)
    else {
      showToast('Richiesta chat inviata')
      sendPushNotification({
        kind: 'contact_request',
        title: 'Nuova richiesta chat',
        body: `${profile?.full_name || 'Un utente'} vuole chattare con te`,
        recipientIds: [target.id],
      })
      setQuery('')
      setResults([])
      loadChatData()
    }
    setBusy(false)
  }

  async function respondRequest(req, accept) {
    setBusy(true)
    const { error } = await supabase.rpc('respond_contact_request', { request_id: req.id, accept })
    if (error) showToast(error.message)
    else {
      showToast(accept ? 'Richiesta accettata' : 'Richiesta rifiutata')
      sendPushNotification({
        kind: 'contact_response',
        title: accept ? 'Richiesta chat accettata' : 'Richiesta chat rifiutata',
        body: `${profile?.full_name || 'Un utente'} ha risposto alla tua richiesta`,
        recipientIds: [req.requester_id],
      })
      loadChatData()
    }
    setBusy(false)
  }

  async function loadMessages(chat) {
    const { data, error } = await supabase
      .from('direct_messages')
      .select('*')
      .eq('chat_id', chat.id)
      .order('created_at', { ascending: true })
      .limit(200)

    if (error) showToast(error.message)
    else setMessages(data || [])
  }

  async function sendMessage(e) {
    e.preventDefault()
    const body = message.trim()
    if (!body || !selectedChat?.id) return
    setMessage('')
    const { data: created, error } = await supabase
      .from('direct_messages')
      .insert({ chat_id: selectedChat.id, sender_id: user.id, body })
      .select('id,body')
      .single()

    if (error) {
      setMessage(body)
      showToast(error.message)
    } else {
      setMessages((prev) => prev.some((m) => m.id === created.id) ? prev : [...prev, { ...created, chat_id: selectedChat.id, sender_id: user.id }])
      sendPushNotification({
        kind: 'chat',
        title: `Messaggio da ${profile?.full_name || 'Orchidea'}`,
        body: body.slice(0, 140),
        sourceTable: 'direct_messages',
        sourceId: created.id,
        recipientIds: [selectedChat.other_id],
      })
      loadChatData()
    }
  }

  const selectedOther = selectedChat?.other?.full_name || selectedChat?.other?.email || 'Chat'

  return (
    <div className="chat-layout">
      <aside className="panel solid chat-sidebar">
        <h2>Chat</h2>
        <p className="muted-text">Aggiungi un utente con richiesta. La chat si apre solo se accetta.</p>
        <button type="button" className={requestOpen ? 'ghost chat-new-btn' : 'primary chat-new-btn'} onClick={() => setRequestOpen((v) => !v)}>
          {requestOpen ? 'Chiudi richiesta' : '+ Nuova richiesta chat'}
        </button>
        {requestOpen && (
          <div className="chat-request-box">
            <Field label="Cerca utente" value={query} onChange={setQuery} placeholder="Nome o email" />
            <div className="search-results">
              {results.map((r) => (
                <div key={r.id} className="contact-row">
                  <div><strong>{r.full_name || 'Utente'}</strong><span>{r.email || ''}</span></div>
                  <button disabled={busy} onClick={() => sendRequest(r)}>Richiedi</button>
                </div>
              ))}
              {query.trim().length >= 2 && !results.length && <Empty text="Nessun utente trovato." />}
            </div>
          </div>
        )}

        {!!incoming.length && <h3>Richieste ricevute</h3>}
        {incoming.map((r) => (
          <div key={r.id} className="request-card">
            <strong>{r.requester?.full_name || r.requester?.email || 'Utente'}</strong>
            <span>Vuole chattare con te</span>
            <div className="row-actions">
              <button disabled={busy} onClick={() => respondRequest(r, true)}>Accetta</button>
              <button disabled={busy} className="danger" onClick={() => respondRequest(r, false)}>Rifiuta</button>
            </div>
          </div>
        ))}

        {!!outgoing.length && <h3>Richieste inviate</h3>}
        {outgoing.map((r) => (
          <div key={r.id} className="request-card muted">
            <strong>{r.recipient?.full_name || r.recipient?.email || 'Utente'}</strong>
            <span>In attesa di risposta</span>
          </div>
        ))}

        <h3>Conversazioni</h3>
        <div className="chat-list">
          {chats.map((chat) => (
            <button key={chat.id} className={selectedChat?.id === chat.id ? 'chat-list-item active' : 'chat-list-item'} onClick={() => setSelectedChat(chat)}>
              <span className="avatar small">{(chat.other?.full_name || chat.other?.email || 'U').slice(0, 1).toUpperCase()}</span>
              <span>{chat.other?.full_name || chat.other?.email || 'Utente'}</span>
            </button>
          ))}
          {!chats.length && <Empty text="Nessuna chat attiva. Cerca Laura o un altro utente e invia una richiesta." />}
        </div>
      </aside>

      <section className="panel chat-main">
        {selectedChat ? (
          <>
            <div className="chat-header">
              <div className="avatar">{selectedOther.slice(0, 1).toUpperCase()}</div>
              <div><h2>{selectedOther}</h2><span>Chat privata</span></div>
            </div>
            <div className="messages-list">
              {messages.map((m) => (
                <div key={m.id} className={m.sender_id === user.id ? 'message-bubble mine' : 'message-bubble'}>
                  <p>{m.body}</p>
                  <small>{fmtDateTime(m.created_at)}</small>
                </div>
              ))}
              {!messages.length && <Empty text="Scrivi il primo messaggio." />}
            </div>
            <form className="message-form" onSubmit={sendMessage}>
              <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Scrivi un messaggio..." />
              <button className="primary">Invia</button>
            </form>
          </>
        ) : (
          <div className="empty-chat"><h2>Seleziona una chat</h2><p>Oppure cerca un utente e inviagli una richiesta.</p></div>
        )}
      </section>
    </div>
  )
}

function Settings({ currentSpace, data, showToast, reloadSpaces }) {
  const [name, setName] = useState(currentSpace.name)

  async function saveSpace(e) {
    e.preventDefault()
    const { error } = await supabase.from('spaces').update({ name }).eq('id', currentSpace.id)
    if (error) showToast(error.message)
    else {
      showToast('Spazio aggiornato')
      reloadSpaces()
    }
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(currentSpace.invite_code)
    showToast('Codice copiato')
  }

  return (
    <div className="two-col">
      <form className="panel solid" onSubmit={saveSpace}>
        <h2>Impostazioni spazio</h2>
        <Field label="Nome spazio" value={name} onChange={setName} />
        <button className="primary">Salva</button>
        <hr />
        <label className="field"><span>Codice invito</span><div className="invite-code">{currentSpace.invite_code}</div></label>
        <button type="button" className="secondary" onClick={copyInvite}>Copia codice per Laura</button>
        <button type="button" className="danger wide" onClick={() => supabase.auth.signOut()}>Esci dall'account</button>
      </form>

      <section className="panel">
        <h2>Membri</h2>
        <div className="members-list">
          {data.members.map((m) => (
            <div key={m.user_id} className="member-row">
              <div className="avatar small">{(m.profile?.full_name || 'O').slice(0, 1).toUpperCase()}</div>
              <div><strong>{m.profile?.full_name || 'Utente'}</strong><span>{m.role}</span></div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function FormLauncher({ open, title, description, buttonLabel, openLabel = 'Chiudi', onOpen, onClose, children }) {
  return (
    <section className={open ? 'form-launcher open' : 'form-launcher'}>
      <div className="form-launcher-head">
        <div>
          <span className="tag">Aggiungi</span>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button type="button" className={open ? 'ghost launcher-btn' : 'primary launcher-btn'} onClick={open ? onClose : onOpen}>
          {open ? openLabel : buttonLabel}
        </button>
      </div>
      {open && <div className="form-launcher-body">{children}</div>}
    </section>
  )
}

function StatCard({ title, value, note, icon }) {
  return <article className="stat-card"><div>{icon}</div><span>{title}</span><strong>{value}</strong><p>{note}</p></article>
}

function Panel({ title, action, children }) {
  return <section className="panel"><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>
}

function TaskMini({ task, memberName }) {
  return (
    <div className="mini-item">
      <b>{task.title}</b>
      <span><em className={`priority-chip mini priority-chip-${task.priority}`}>{task.priority}</em> {fmtDate(task.due_date)} · {memberName(task.assigned_to)}</span>
    </div>
  )
}

function EventMini({ event }) {
  return <div className="mini-item"><b>{event.title}</b><span>{fmtDateTime(event.starts_at)} · {event.location || event.category}</span></div>
}

function AnnouncementItem({ item }) {
  return <div className={`mini-item announcement-mini importance-${item.importance}`}><b>{item.title}</b><span>{item.body}</span></div>
}

function Empty({ text }) {
  return <div className="empty">{text}</div>
}

function Field({ label, value, onChange, type = 'text', placeholder = '', required = false, ...inputProps }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required} {...inputProps} />
    </label>
  )
}

function Textarea({ label, value, onChange, placeholder = '' }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={5} />
    </label>
  )
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  )
}

function MemberSelect({ label, members, value, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Non assegnato</option>
        {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name || 'Utente'}</option>)}
      </select>
    </label>
  )
}

export default App
