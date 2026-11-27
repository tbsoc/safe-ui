import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import { handleQueueRequest } from './src/server/queueProxy'

/**
 * Serves /api/safe-queue/* in `vite dev` and `vite preview` with the same code as the Cloudflare
 * Pages Function, reading SAFE_API_KEY / ALLOWED_SAFES from the shell environment. The key stays
 * in this Node process and is never bundled into the app.
 */
function safeQueueDevProxy(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/safe-queue/')) return next()
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const url = new URL(req.url, 'http://localhost')
    const request = new Request(url, {
      method: req.method,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    })
    const path = url.pathname.slice('/api/safe-queue/'.length)
    const response = await handleQueueRequest(request, {
        SAFE_API_KEY: process.env.SAFE_API_KEY,
        ALLOWED_SAFES: process.env.ALLOWED_SAFES,
        SAFE_QUEUE_UPSTREAM: process.env.SAFE_QUEUE_UPSTREAM,
      }, path)
    res.statusCode = response.status
    response.headers.forEach((v, k) => res.setHeader(k, v))
    res.end(await response.text())
  }
  return {
    name: 'safe-queue-dev-proxy',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  }
}

export default defineConfig({
  plugins: [react(), safeQueueDevProxy()],
})
