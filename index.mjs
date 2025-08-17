// Minimal Web Push sender API using Express and Supabase
import express from 'express'
import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'
import admin from 'firebase-admin'
import fs from 'node:fs'
import path from 'node:path'

// Local config fallback (server/push.local.json)
try {
  const projectRoot = process.cwd()
  const localConfigPath = path.join(projectRoot, 'server', 'push.local.json')
  if (fs.existsSync(localConfigPath)) {
    const raw = fs.readFileSync(localConfigPath, 'utf8')
    const cfg = JSON.parse(raw)
    if (cfg && typeof cfg === 'object') {
      for (const [k, v] of Object.entries(cfg)) {
        if (!process.env[k] && v != null) {
          process.env[k] = String(v)
        }
      }
      // Normalize service account path to absolute if needed
      if (process.env.FIREBASE_SERVICE_ACCOUNT_FILE && !path.isAbsolute(process.env.FIREBASE_SERVICE_ACCOUNT_FILE)) {
        process.env.FIREBASE_SERVICE_ACCOUNT_FILE = path.join(projectRoot, process.env.FIREBASE_SERVICE_ACCOUNT_FILE)
      }
    }
  }
} catch (e) {
  console.warn('Failed to load server/push.local.json', e)
}

const PORT = process.env.PORT || 8787
const PUSH_PROVIDER = process.env.PUSH_PROVIDER || process.env.VITE_PUSH_PROVIDER || 'webpush' // 'webpush' | 'fcm' | 'both'
const API_TOKEN = process.env.API_TOKEN || ''

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com'

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
let webpushConfigured = false
if (PUSH_PROVIDER === 'webpush' || PUSH_PROVIDER === 'both') {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error('Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY for Web Push mode')
  } else {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
    webpushConfigured = true
  }
}
if (!API_TOKEN) {
  console.warn('WARNING: API_TOKEN not set. Protect your endpoint before exposing it publicly.')
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const app = express()
app.use(express.json())
// Basic CORS for local dev and simple deployments
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// Simple auth middleware
app.use((req, res, next) => {
  if (!API_TOKEN) return next()
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token !== API_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  next()
})

// POST /push/send-to-user { userId, notification: { title, body, url, icon, tag } }
app.post('/push/send-to-user', async (req, res) => {
  if (!(PUSH_PROVIDER === 'webpush' || PUSH_PROVIDER === 'both') || !webpushConfigured) {
    return res.status(503).json({ error: 'webpush_not_configured' })
  }
  try {
    const { userId, notification } = req.body || {}
    if (!userId || !notification) return res.status(400).json({ error: 'userId and notification are required' })

    const { data: subs, error } = await supabase
      .from('user_push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId)
    if (error) return res.status(500).json({ error: 'db_error', details: error.message })
    if (!subs || subs.length === 0) return res.json({ sent: 0 })

    let sent = 0
    const payload = JSON.stringify({
      title: notification.title || 'Pediaê',
      body: notification.body || '',
      url: notification.url || '/',
      icon: notification.icon || '/icons/icon-192x192.png',
      tag: notification.tag,
    })

    const results = []
    for (const s of subs) {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth }
      }
      try {
        const resp = await webpush.sendNotification(subscription, payload)
        sent += 1
        results.push({ endpoint: s.endpoint, status: resp.statusCode })
      } catch (e) {
        results.push({ endpoint: s.endpoint, error: e?.body || e?.message || 'push_error' })
      }
    }

    res.json({ sent, results })
  } catch (e) {
    res.status(500).json({ error: 'server_error', details: e?.message || String(e) })
  }
})

// Initialize Firebase Admin for FCM if service account is provided
try {
  let svc = null
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try { svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) } catch (e) { console.error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON', e) }
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_FILE && fs.existsSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE)) {
    try { svc = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8')) } catch (e) { console.error('Invalid FIREBASE_SERVICE_ACCOUNT_FILE', e) }
  }
  if (svc) {
    admin.initializeApp({ credential: admin.credential.cert(svc) })
    console.log('Firebase Admin initialized')
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT_JSON not set; FCM endpoint may be disabled')
  }
} catch (e) {
  console.error('Failed to initialize Firebase Admin', e)
}

// POST /push/fcm-send-to-user { userId, notification: { title, body, url, icon, tag } }
app.post('/push/fcm-send-to-user', async (req, res) => {
  if (!(PUSH_PROVIDER === 'fcm' || PUSH_PROVIDER === 'both')) {
    return res.status(503).json({ error: 'fcm_not_enabled' })
  }
  try {
    if (!admin?.apps?.length) return res.status(503).json({ error: 'fcm_not_configured' })
    const { userId, notification } = req.body || {}
    if (!userId || !notification) return res.status(400).json({ error: 'userId and notification required' })

    const { data: tokens, error } = await supabase
      .from('user_fcm_tokens')
      .select('token')
      .eq('user_id', userId)
    if (error) return res.status(500).json({ error: 'db_error', details: error.message })
    const tokenList = (tokens || []).map(t => t.token).filter(Boolean)
    if (tokenList.length === 0) return res.json({ sent: 0 })

    const message = {
      notification: { title: notification.title || 'Pediaê', body: notification.body || '' },
      webpush: { fcmOptions: { link: notification.url || '/' } },
      android: { notification: { icon: 'ic_notification', color: '#EF4444' } },
      apns: { payload: { aps: { 'mutable-content': 1 } } },
      tokens: tokenList,
    }

    const resp = await admin.messaging().sendEachForMulticast(message)
    res.json({ sent: resp.successCount, failureCount: resp.failureCount })
  } catch (e) {
    res.status(500).json({ error: 'server_error', details: e?.message || String(e) })
  }
})

// ===== SumUp (no-webhook) minimal integration =====
const SUMUP_CLIENT_ID = process.env.SUMUP_CLIENT_ID || process.env.VITE_SUMUP_CLIENT_ID || ''
const SUMUP_CLIENT_SECRET = process.env.SUMUP_CLIENT_SECRET || ''
const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE || ''
const SUMUP_SUCCESS_URL = process.env.SUMUP_SUCCESS_URL || ''
const SUMUP_CANCEL_URL = process.env.SUMUP_CANCEL_URL || ''

let sumupTokenCache = { token: '', expiresAt: 0 }
async function getSumupToken() {
  const now = Date.now()
  if (sumupTokenCache.token && sumupTokenCache.expiresAt - 60_000 > now) return sumupTokenCache.token
  const body = new URLSearchParams()
  body.append('grant_type', 'client_credentials')
  body.append('client_id', SUMUP_CLIENT_ID)
  body.append('client_secret', SUMUP_CLIENT_SECRET)
  const resp = await fetch('https://api.sumup.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (!resp.ok) throw new Error(`sumup_oauth_failed ${resp.status}`)
  const data = await resp.json()
  sumupTokenCache = { token: data.access_token, expiresAt: now + (Number(data.expires_in || 600) * 1000) }
  return sumupTokenCache.token
}

// Create SumUp checkout (Checkout Pro hosted)
// Body: { pedidoId, amount, currency?, restaurant: { id, nome } }
app.post('/payments/sumup/create', async (req, res) => {
  try {
    if (!SUMUP_CLIENT_ID || !SUMUP_CLIENT_SECRET || !SUMUP_MERCHANT_CODE) {
      return res.status(500).json({ error: 'sumup_not_configured' })
    }
    const { pedidoId, amount, currency = 'BRL', restaurant } = req.body || {}
    if (!pedidoId || !amount) return res.status(400).json({ error: 'missing_fields' })
    const accessToken = await getSumupToken()
    const baseUrl = `${req.protocol}://${req.get('host')}`
    const returnUrl = `${baseUrl}/payments/sumup/return?pedido_id=${encodeURIComponent(pedidoId)}`
    const description = `${restaurant?.nome || 'Restaurante'} — Pedido #${pedidoId} (Pediaê)`
    const payload = {
      checkout_reference: String(pedidoId),
      amount: Number(amount),
      currency,
      merchant_code: SUMUP_MERCHANT_CODE,
      pay_to_email: undefined,
      description,
      return_url: returnUrl,
      payment_type: 'card', // SumUp decide no hosted; Pix pode ser alternativo conforme contrato
    }
    const resp = await fetch('https://api.sumup.com/v0.1/checkouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload)
    })
    const data = await resp.json()
    if (!resp.ok) return res.status(500).json({ error: 'sumup_checkout_failed', details: data })
    // Expected fields: id, checkout_reference, amount, currency, status, redirect_url/payment_link
    const checkoutUrl = data?.redirect_url || data?.payment_link || data?.checkout_url
    if (!checkoutUrl) return res.status(500).json({ error: 'sumup_checkout_missing_url', data })
    res.json({ checkout_id: data.id, url: checkoutUrl })
  } catch (e) {
    res.status(500).json({ error: 'server_error', details: e?.message || String(e) })
  }
})

// Return handler: confirms payment and redirects to final URLs
app.get('/payments/sumup/return', async (req, res) => {
  const pedidoId = String(req.query.pedido_id || '')
  const checkoutId = String(req.query.checkout_id || req.query.checkoutId || '')
  const txId = String(req.query.transaction_id || req.query.transactionId || '')
  try {
    const accessToken = await getSumupToken()
    let status = 'PENDING'
    let tx = null
    if (checkoutId) {
      const r = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(checkoutId)}`, { headers: { Authorization: `Bearer ${accessToken}` } })
      const j = await r.json()
      status = j?.status || status
    }
    if (txId && (status === 'PENDING' || status === 'PAID' || status === 'APPROVED')) {
      const r2 = await fetch(`https://api.sumup.com/v0.1/transactions/${encodeURIComponent(txId)}`, { headers: { Authorization: `Bearer ${accessToken}` } })
      tx = await r2.json()
      if (tx?.status) status = tx.status
    }

    const approved = /PAID|APPROVED|SUCCESS/i.test(status)
    if (approved && pedidoId) {
      try {
        const note = `Pago via SumUp ${tx?.id || checkoutId || ''}`
        await supabase
          .from('pedidos')
          .update({ status: 'aceito', observacoes: note } as any)
          .eq('id', pedidoId)
      } catch {}
    }
    const finalUrl = approved && SUMUP_SUCCESS_URL ? SUMUP_SUCCESS_URL : (SUMUP_CANCEL_URL || '/')
    res.redirect(finalUrl)
  } catch (e) {
    res.redirect(SUMUP_CANCEL_URL || '/')
  }
})

app.get('/health', (req, res) => res.json({ ok: true }))

app.listen(PORT, () => {
  console.log(`Push API listening on :${PORT} (provider=${PUSH_PROVIDER}${webpushConfigured ? ', webpush-ready' : ''}${admin?.apps?.length ? ', fcm-ready' : ''})`)
})



