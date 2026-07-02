import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:info@orchidea.app'

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Metodo non consentito' }, 405)

  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return jsonResponse({ error: 'VAPID keys mancanti nei secrets della Edge Function' }, 500)
    }

    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace('Bearer ', '')
    const { data: userData, error: userError } = await admin.auth.getUser(jwt)
    if (userError || !userData.user) return jsonResponse({ error: 'Non autenticato' }, 401)

    const actorId = userData.user.id
    const payload = await req.json()
    const title = String(payload.title || 'Orchidea Organizer').slice(0, 100)
    const body = String(payload.body || 'Nuovo aggiornamento').slice(0, 240)
    const kind = String(payload.kind || 'generic').slice(0, 60)
    const priority = String(payload.priority || 'normale').slice(0, 40)
    const spaceId = payload.space_id ? String(payload.space_id) : null
    const recipientIdsFromBody = Array.isArray(payload.recipient_ids) ? payload.recipient_ids.map(String) : null

    let recipientIds: string[] = []

    if (recipientIdsFromBody?.length) {
      recipientIds = [...new Set(recipientIdsFromBody.filter((id) => id && id !== actorId))].slice(0, 20)
    } else if (spaceId) {
      const { data: members, error: membersError } = await admin
        .from('space_members')
        .select('user_id')
        .eq('space_id', spaceId)

      if (membersError) throw membersError
      const memberIds = (members || []).map((m) => m.user_id)
      if (!memberIds.includes(actorId)) return jsonResponse({ error: 'Non sei membro di questo spazio' }, 403)
      recipientIds = memberIds.filter((id) => id !== actorId)
    }

    if (!recipientIds.length) return jsonResponse({ ok: true, sent: 0, reason: 'Nessun destinatario' })

    const notificationRows = recipientIds.map((recipientId) => ({
      recipient_id: recipientId,
      actor_id: actorId,
      space_id: spaceId,
      kind,
      title,
      body,
      priority,
      source_table: payload.source_table ? String(payload.source_table).slice(0, 80) : null,
      source_id: payload.source_id ? String(payload.source_id) : null,
    }))

    await admin.from('app_notifications').insert(notificationRows)

    const { data: subscriptions, error: subError } = await admin
      .from('push_subscriptions')
      .select('id,user_id,endpoint,p256dh,auth')
      .in('user_id', recipientIds)
      .eq('active', true)

    if (subError) throw subError

    const webPushPayload = JSON.stringify({
      title,
      body,
      icon: '/image/icon.png',
      badge: '/image/icon.png',
      tag: `${kind}-${payload.source_id || Date.now()}`,
      url: payload.url || '/',
    })

    let sent = 0
    await Promise.all((subscriptions || []).map(async (sub) => {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        }, webPushPayload, { TTL: priority === 'urgente' ? 86400 : 21600 })
        sent += 1
      } catch (error) {
        const statusCode = Number(error?.statusCode || error?.status || 0)
        if (statusCode === 404 || statusCode === 410) {
          await admin.from('push_subscriptions').update({ active: false }).eq('id', sub.id)
        }
        console.error('Errore invio push', statusCode, error?.message || error)
      }
    }))

    return jsonResponse({ ok: true, recipients: recipientIds.length, push_sent: sent })
  } catch (error) {
    console.error(error)
    return jsonResponse({ error: error?.message || 'Errore invio notifiche' }, 500)
  }
})
