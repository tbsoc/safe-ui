// Cloudflare Worker entry: serves the built app (dist/) and the shared-queue proxy.
// /api/safe-queue/* -> Safe Queue Service with the API key added server-side; everything else -> static files.
// Set SAFE_API_KEY (Secret) and ALLOWED_SAFES under the Worker's Settings > Variables and Secrets.
import { handleQueueRequest, type QueueProxyEnv } from '../src/server/queueProxy'

interface Env extends QueueProxyEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

const PREFIX = '/api/safe-queue/'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith(PREFIX)) return handleQueueRequest(request, env, url.pathname.slice(PREFIX.length))
    return env.ASSETS.fetch(request)
  },
}
