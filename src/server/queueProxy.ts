/**
 * Server-side proxy to Safe's Queue Service (https://api.safe.global/queue).
 *
 * It runs as a Cloudflare Pages Function (functions/api/safe-queue/[[path]].ts) and in the Vite
 * dev server, so the Safe API key never reaches the browser. Only the four calls the app needs are
 * forwarded; everything else gets a 404.
 *
 * Environment:
 *   SAFE_API_KEY   required. Key from https://developer.safe.global
 *   ALLOWED_SAFES  optional. Comma-separated "chainId:0xSafe" (or just "0xSafe" for any chain).
 *                  When set, listing and proposing are limited to these Safes, so strangers can't
 *                  spend your API quota on theirs.
 */

export interface QueueProxyEnv {
  SAFE_API_KEY?: string
  ALLOWED_SAFES?: string
  /** Testing only: point the proxy at a stand-in for Safe's service. */
  SAFE_QUEUE_UPSTREAM?: string
}

export const UPSTREAM = 'https://api.safe.global/queue'
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const MAX_BODY = 64 * 1024

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

interface Allow {
  chainId?: number
  safe: string
}

export function parseAllowed(raw: string | undefined): Allow[] | undefined {
  if (!raw || !raw.trim()) return undefined
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [a, b] = entry.split(':')
      return b ? { chainId: Number(a), safe: b.toLowerCase() } : { safe: a.toLowerCase() }
    })
}

function isAllowed(allowed: Allow[] | undefined, chainId: number, safe: string): boolean {
  if (!allowed) return true
  return allowed.some((a) => a.safe === safe.toLowerCase() && (a.chainId === undefined || a.chainId === chainId))
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > MAX_BODY) throw new Error('Request body too large')
  return JSON.parse(text)
}

export async function handleQueueRequest(
  request: Request,
  env: QueueProxyEnv,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!env.SAFE_API_KEY) return json(503, { error: 'Shared queue is not configured (SAFE_API_KEY missing).' })
  const allowed = parseAllowed(env.ALLOWED_SAFES)
  const url = new URL(request.url)
  const parts = path.replace(/^\/+|\/+$/g, '').split('/')
  const base = parts.slice(0, 3).join('/')
  if (base !== 'api/v1/multisig-transactions') return json(404, { error: 'Not found' })
  const rest = parts.slice(3)

  let upstreamPath: string
  let init: RequestInit = { method: request.method }

  if (request.method === 'GET' && rest.length === 1 && rest[0] === 'queue') {
    // GET …/queue?safes=0xSafe:chainId
    const safes = url.searchParams.get('safes') ?? ''
    const entries = safes.split(',').filter(Boolean)
    if (entries.length === 0 || entries.length > 10) return json(400, { error: 'Pass 1-10 safes as 0xSafe:chainId' })
    for (const e of entries) {
      const [safe, chain] = e.split(':')
      if (!ADDRESS.test(safe ?? '') || !/^\d+$/.test(chain ?? '')) return json(400, { error: 'Pass safes as 0xSafe:chainId' })
      if (!isAllowed(allowed, Number(chain), safe)) return json(403, { error: 'This Safe is not enabled on this site.' })
    }
    const qs = new URLSearchParams({ safes, nonceOrder: 'asc' })
    upstreamPath = `/api/v1/multisig-transactions/queue?${qs}`
  } else if (request.method === 'GET' && rest.length === 1 && HASH.test(rest[0])) {
    upstreamPath = `/api/v1/multisig-transactions/${rest[0]}`
  } else if (request.method === 'POST' && rest.length === 0) {
    // Propose. Forward only the documented fields.
    let body: Record<string, unknown>
    try {
      body = (await readJson(request)) as Record<string, unknown>
    } catch {
      return json(400, { error: 'Invalid JSON body' })
    }
    const chainId = Number(body.chainId)
    const safe = String(body.safe ?? '')
    if (!Number.isInteger(chainId) || !ADDRESS.test(safe)) return json(400, { error: 'chainId and safe are required' })
    if (!isAllowed(allowed, chainId, safe)) return json(403, { error: 'This Safe is not enabled on this site.' })
    const sigs = body.signatures
    if (!Array.isArray(sigs) || sigs.length < 1 || sigs.length > 50) return json(400, { error: '1-50 signatures required' })
    const fields = ['chainId', 'safe', 'to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce', 'signatures', 'originName', 'originUrl', 'notes']
    const clean = Object.fromEntries(fields.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]))
    upstreamPath = '/api/v1/multisig-transactions'
    init = { method: 'POST', body: JSON.stringify(clean) }
  } else if (request.method === 'POST' && rest.length === 2 && HASH.test(rest[0]) && rest[1] === 'signatures') {
    let body: { signatures?: unknown }
    try {
      body = (await readJson(request)) as { signatures?: unknown }
    } catch {
      return json(400, { error: 'Invalid JSON body' })
    }
    if (!Array.isArray(body.signatures) || body.signatures.length < 1 || body.signatures.length > 50)
      return json(400, { error: '1-50 signatures required' })
    upstreamPath = `/api/v1/multisig-transactions/${rest[0]}/signatures`
    init = { method: 'POST', body: JSON.stringify({ signatures: body.signatures }) }
  } else {
    return json(404, { error: 'Not found' })
  }

  const res = await fetchImpl(`${env.SAFE_QUEUE_UPSTREAM || UPSTREAM}${upstreamPath}`, {
    ...init,
    headers: { authorization: `Bearer ${env.SAFE_API_KEY}`, 'content-type': 'application/json', accept: 'application/json' },
  })
  const text = await res.text()
  return new Response(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  })
}
