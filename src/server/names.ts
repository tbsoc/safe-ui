/**
 * Shared address book: names for addresses, readable by anyone, editable only by signers of the
 * configured Safes. Stored in Cloudflare KV (binding NAMES); runs in the Worker and the Vite dev server.
 *
 * Environment:
 *   NAMES         KV namespace binding
 *   NAME_EDITORS  comma-separated "chainId:0xSafe"; current signers of these Safes may edit names
 *
 * Edits are authorized by an EIP-712 signature (no transaction, no chain id in the domain so any
 * network works): SetName{address, name, timestamp}. Signatures older than 10 minutes are refused.
 */
import { getAddress, isAddress, verifyTypedData, type Address, type Hex } from 'viem'

/** The subset of Cloudflare's KVNamespace this uses (names are kept in key metadata, so one list() reads all). */
export interface KVLike {
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string; metadata?: unknown }[]
    list_complete: boolean
    cursor?: string
  }>
}

export interface NamesEnv {
  NAMES?: KVLike
  NAME_EDITORS?: string
}

export type OwnersLookup = (chainId: number, safe: Address) => Promise<Address[]>

export interface NameEntry {
  name: string
  by: Address
  at: number
}

export const NAME_TYPED_DATA = {
  domain: { name: 'Bread Safe address book', version: '1' },
  types: {
    SetName: [
      { name: 'address', type: 'address' },
      { name: 'name', type: 'string' },
      { name: 'timestamp', type: 'uint256' },
    ],
  },
  primaryType: 'SetName',
} as const

export const MAX_NAME = 64
const PREFIX = 'name:'
const MAX_AGE_SEC = 600

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } })
}

export function parseEditors(raw: string | undefined): { chainId: number; safe: Address }[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => {
      const [c, a] = e.split(':')
      return { chainId: Number(c), safe: a as Address }
    })
    .filter((e) => Number.isInteger(e.chainId) && isAddress(e.safe))
}

const ownerCache = new Map<string, { owners: Address[]; at: number }>()

async function isEditor(env: NamesEnv, signer: Address, lookup: OwnersLookup): Promise<boolean> {
  for (const { chainId, safe } of parseEditors(env.NAME_EDITORS)) {
    const key = `${chainId}:${safe.toLowerCase()}`
    let cached = ownerCache.get(key)
    if (!cached || Date.now() - cached.at > 5 * 60_000) {
      try {
        cached = { owners: await lookup(chainId, safe), at: Date.now() }
        ownerCache.set(key, cached)
      } catch {
        continue
      }
    }
    if (cached.owners.some((o) => o.toLowerCase() === signer.toLowerCase())) return true
  }
  return false
}

export async function listNames(kv: KVLike): Promise<Record<string, NameEntry>> {
  const out: Record<string, NameEntry> = {}
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const page = await kv.list({ prefix: PREFIX, cursor, limit: 1000 })
    for (const k of page.keys) {
      const m = k.metadata as NameEntry | undefined
      if (m?.name) out[k.name.slice(PREFIX.length)] = m
    }
    if (page.list_complete || !page.cursor) break
    cursor = page.cursor
  }
  return out
}

export async function handleNamesRequest(request: Request, env: NamesEnv, lookup: OwnersLookup, nowMs = Date.now()): Promise<Response> {
  const kv = env.NAMES
  if (!kv) return json(503, { error: 'Address book is not configured on this site.' })

  if (request.method === 'GET') return json(200, { names: await listNames(kv) }, { 'cache-control': 'public, max-age=15' })
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' })

  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > 4096) throw new Error('too large')
    body = JSON.parse(text)
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }
  const { address, signer, signature } = body as { address?: string; signer?: string; signature?: string }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const timestamp = Number(body.timestamp)
  if (!address || !isAddress(address) || !signer || !isAddress(signer) || typeof signature !== 'string')
    return json(400, { error: 'address, signer and signature are required' })
  if (name.length > MAX_NAME) return json(400, { error: `Names can be at most ${MAX_NAME} characters` })
  if (!Number.isInteger(timestamp) || Math.abs(nowMs / 1000 - timestamp) > MAX_AGE_SEC)
    return json(400, { error: 'Signature expired; please sign again' })

  let valid = false
  try {
    valid = await verifyTypedData({
      ...NAME_TYPED_DATA,
      address: getAddress(signer),
      message: { address: getAddress(address), name, timestamp: BigInt(timestamp) },
      signature: signature as Hex,
    })
  } catch {
    valid = false
  }
  if (!valid) return json(401, { error: 'Signature does not match the signer' })
  if (!(await isEditor(env, getAddress(signer), lookup)))
    return json(403, { error: 'Only signers of the co-op Safes can edit the address book' })

  const key = PREFIX + address.toLowerCase()
  if (!name) {
    await kv.delete(key)
    return json(200, { address: getAddress(address), name: '' })
  }
  const entry: NameEntry = { name, by: getAddress(signer), at: Math.floor(nowMs / 1000) }
  await kv.put(key, '', { metadata: entry })
  return json(200, { address: getAddress(address), ...entry })
}

/** In-memory KV for the Vite dev server and tests. */
export function memoryKV(): KVLike {
  const m = new Map<string, unknown>()
  return {
    async put(key, _value, options) {
      m.set(key, options?.metadata)
    },
    async delete(key) {
      m.delete(key)
    },
    async list(options) {
      const keys = [...m.entries()].filter(([k]) => k.startsWith(options?.prefix ?? '')).map(([name, metadata]) => ({ name, metadata }))
      return { keys, list_complete: true }
    },
  }
}
