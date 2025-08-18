import { createClient } from '@supabase/supabase-js'

const SUMUP_CLIENT_ID = process.env.SUMUP_CLIENT_ID || ''
const SUMUP_CLIENT_SECRET = process.env.SUMUP_CLIENT_SECRET || ''
const SUMUP_MERCHANT_CODE = process.env.SUMUP_MERCHANT_CODE || ''

async function getSumupToken() {
  const body = new URLSearchParams()
  body.append('grant_type', 'client_credentials')
  body.append('client_id', SUMUP_CLIENT_ID)
  body.append('client_secret', SUMUP_CLIENT_SECRET)
  const resp = await fetch('https://api.sumup.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (!resp.ok) {
    const t = await resp.text()
    throw new Error(`sumup_oauth_failed ${resp.status} ${t}`)
  }
  const data = await resp.json()
  return data.access_token
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  try {
    if (!SUMUP_CLIENT_ID || !SUMUP_CLIENT_SECRET || !SUMUP_MERCHANT_CODE) {
      return res.status(500).json({ error: 'sumup_not_configured' })
    }
    const { pedidoId, amount, currency = 'BRL', restaurant } = req.body || {}
    if (!pedidoId || !amount) return res.status(400).json({ error: 'missing_fields' })
    const token = await getSumupToken()

    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
    const returnUrl = `${baseUrl}/api/payments/sumup/return?pedido_id=${encodeURIComponent(pedidoId)}`
    const description = `${restaurant?.nome || 'Restaurante'} — Pedido #${pedidoId} (Pediaê)`
    const payload = {
      checkout_reference: String(pedidoId),
      amount: Number(amount),
      currency,
      merchant_code: SUMUP_MERCHANT_CODE,
      description,
      return_url: returnUrl,
    }
    const resp = await fetch('https://api.sumup.com/v0.1/checkouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    })
    const data = await resp.json()
    if (!resp.ok) return res.status(500).json({ error: 'sumup_checkout_failed', details: data })
    const checkoutUrl = data?.redirect_url || data?.payment_link || data?.checkout_url
    if (!checkoutUrl) return res.status(500).json({ error: 'sumup_checkout_missing_url', data })
    res.status(200).json({ checkout_id: data.id, url: checkoutUrl })
  } catch (e) {
    res.status(500).json({ error: 'server_error', details: e?.message || String(e) })
  }
}

export const config = { runtime: 'nodejs18.x' }


