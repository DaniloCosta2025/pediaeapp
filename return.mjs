import { createClient } from '@supabase/supabase-js'

const SUMUP_CLIENT_ID = process.env.SUMUP_CLIENT_ID || ''
const SUMUP_CLIENT_SECRET = process.env.SUMUP_CLIENT_SECRET || ''
const SUMUP_SUCCESS_URL = process.env.SUMUP_SUCCESS_URL || '/'
const SUMUP_CANCEL_URL = process.env.SUMUP_CANCEL_URL || '/'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null

async function getSumupToken() {
  const body = new URLSearchParams()
  body.append('grant_type', 'client_credentials')
  body.append('client_id', SUMUP_CLIENT_ID)
  body.append('client_secret', SUMUP_CLIENT_SECRET)
  const resp = await fetch('https://api.sumup.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (!resp.ok) throw new Error(`sumup_oauth_failed ${resp.status}`)
  const data = await resp.json()
  return data.access_token
}

export default async function handler(req, res) {
  try {
    const pedidoId = String(req.query.pedido_id || '')
    const checkoutId = String(req.query.checkout_id || req.query.checkoutId || '')
    const txId = String(req.query.transaction_id || req.query.transactionId || '')
    const token = await getSumupToken()
    let status = 'PENDING'

    if (checkoutId) {
      const r = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(checkoutId)}`, { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      status = j?.status || status
    }
    if (txId && (status === 'PENDING' || status === 'PAID' || status === 'APPROVED')) {
      const r2 = await fetch(`https://api.sumup.com/v0.1/transactions/${encodeURIComponent(txId)}`, { headers: { Authorization: `Bearer ${token}` } })
      const t = await r2.json()
      if (t?.status) status = t.status
    }
    const approved = /PAID|APPROVED|SUCCESS/i.test(status)
    if (approved && pedidoId && supabase) {
      try { await supabase.from('pedidos').update({ status: 'aceito' } as any).eq('id', pedidoId) } catch {}
    }
    res.redirect(approved ? SUMUP_SUCCESS_URL : SUMUP_CANCEL_URL)
  } catch (e) {
    res.redirect(SUMUP_CANCEL_URL)
  }
}

export const config = { runtime: 'nodejs18.x' }


