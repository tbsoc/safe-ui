// Cloudflare Worker entry: serves the built app (dist/), the shared-queue proxy and the address book.
// /api/safe-queue/* -> Safe Queue Service with the API key added server-side
// /api/names        -> shared address book (KV binding NAMES; editors: signers of NAME_EDITORS Safes)
// everything else   -> static files
// Set SAFE_API_KEY (Secret) under the Worker's Settings > Variables and Secrets.
import { handleNamesRequest, type NamesEnv } from '../src/server/names'
import { ownersLookup } from '../src/server/owners'
import { handleQueueRequest, type QueueProxyEnv } from '../src/server/queueProxy'

interface Env extends QueueProxyEnv, NamesEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

const PREFIX = '/api/safe-queue/'
const lookup = ownersLookup()

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith(PREFIX)) return handleQueueRequest(request, env, url.pathname.slice(PREFIX.length))
    if (url.pathname === '/api/names') return handleNamesRequest(request, env, lookup)
    return env.ASSETS.fetch(request)
  },
}
