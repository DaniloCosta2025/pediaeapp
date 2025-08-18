import Stripe from 'stripe'

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || ''
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || ''
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || ''

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  if (!stripe) return res.status(500).json({ error: 'stripe_not_configured' })

  try {
    const { pedidoId, amount, restaurant } = req.body || {}
    if (!pedidoId || !amount || !restaurant?.nome) {
      return res.status(400).json({ error: 'missing_fields' })
    }

    const successUrl = STRIPE_SUCCESS_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/checkout/success`
    const cancelUrl = STRIPE_CANCEL_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/checkout/cancel`

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'pix'],
      currency: 'brl',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'brl',
            product_data: { name: `${restaurant.nome} — Pedido #${pedidoId} (Pediaê)` },
            unit_amount: Math.round(Number(amount) * 100),
          },
        },
      ],
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        pedido_id: String(pedidoId),
        restaurante_id: String(restaurant.id || ''),
        restaurante_nome: String(restaurant.nome),
      },
      payment_intent_data: {
        metadata: {
          pedido_id: String(pedidoId),
          restaurante_id: String(restaurant.id || ''),
          restaurante_nome: String(restaurant.nome),
        },
      },
      payment_method_options: {
        card: {
          installments: { enabled: true },
        },
      },
    })

    return res.status(200).json({ url: session.url, id: session.id })
  } catch (e) {
    return res.status(500).json({ error: 'stripe_error', details: e?.message || String(e) })
  }
}

export const config = { runtime: 'nodejs18.x' }


