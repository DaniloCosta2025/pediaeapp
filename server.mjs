import app from '../server/index.mjs'

// Exporta o Express app como função serverless para Vercel
export default app

// Opcional: configurações do runtime
export const config = {
  runtime: 'nodejs18.x'
}


