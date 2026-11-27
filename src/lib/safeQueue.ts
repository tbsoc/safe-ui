/**
 * Client for Safe's shared Queue Service, reached through this site's own proxy
 * (/api/safe-queue, see src/server/queueProxy.ts) so the API key stays server-side.
 *
 * Pending transactions and signatures stored there are visible to every signer, in this app and in
 * Safe{Wallet}. Nothing here is trusted blindly: every transaction and signature that comes back is
 * re-checked against the Safe (hash + signer recovery) before it is shown or counted.
 */
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
import type { PendingTx } from './queue'
import type { SafeTx } from './safe'

const BASE = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SAFE_QUEUE_URL ?? '/api/safe-queue').replace(/\/$/, '')

export class QueueUnavailableError extends Error {}

export interface RemoteConfirmation {
  owner: Address
  signature: Hex
  signatureType: string
}

export interface RemoteTx {
  chainId: number
  safe: Address
  safeTxHash: Hex
  tx: SafeTx
  confirmations: RemoteConfirmation[]
  notes: string
  originName: string
  executed: boolean
}

export async function queueCall<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BASE) throw new QueueUnavailableError('Shared queue disabled')
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  } catch {
    throw new QueueUnavailableError('Shared queue unreachable')
  }
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  // No proxy on this host (static-only deploy answers with the app's HTML) or proxy not configured.
  if (res.status === 204) return undefined as T
  const isJson = (res.headers.get('content-type') ?? '').includes('json')
  if (res.status === 503 || !isJson || (res.status === 404 && body === undefined))
    throw new QueueUnavailableError('Shared queue not configured on this site')
  if (!res.ok) {
    const b = body as Record<string, unknown> | undefined
    const msg = b?.error ?? b?.message ?? b?.detail ?? b?.error_msg ?? text.slice(0, 200)
    const err = new Error(`Safe queue (${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return body as T
}

const num = (v: unknown) => (v === null || v === undefined ? '0' : String(v))

/** Convert a Queue Service transaction to our shape. Returns undefined for anything malformed. */
export function parseRemoteTx(r: Record<string, unknown>): RemoteTx | undefined {
  if (!isAddress(String(r.safe)) || !isHex(r.safeTxHash) || !isAddress(String(r.to))) return undefined
  const op = Number(r.operation)
  if (op !== 0 && op !== 1) return undefined
  const zero = '0x0000000000000000000000000000000000000000'
  const tx: SafeTx = {
    to: getAddress(String(r.to)),
    value: num(r.value),
    data: (isHex(r.data) ? r.data : '0x') as Hex,
    operation: op,
    safeTxGas: num(r.safeTxGas),
    baseGas: num(r.baseGas),
    gasPrice: num(r.gasPrice),
    gasToken: getAddress(isAddress(String(r.gasToken)) ? String(r.gasToken) : zero),
    refundReceiver: getAddress(isAddress(String(r.refundReceiver)) ? String(r.refundReceiver) : zero),
    nonce: num(r.nonce),
  }
  if (![tx.value, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.nonce].every((x) => /^\d+$/.test(x))) return undefined
  const confirmations = (Array.isArray(r.confirmations) ? r.confirmations : [])
    .map((c: Record<string, unknown>) => ({ owner: String(c.owner), signature: String(c.signature), signatureType: String(c.signatureType ?? '') }))
    .filter((c) => isAddress(c.owner) && isHex(c.signature))
    .map((c) => ({ ...c, owner: getAddress(c.owner), signature: c.signature as Hex }))
  return {
    chainId: Number(r.chainId),
    safe: getAddress(String(r.safe)),
    safeTxHash: r.safeTxHash as Hex,
    tx,
    confirmations,
    notes: typeof r.notes === 'string' ? r.notes : '',
    originName: typeof r.originName === 'string' ? r.originName : '',
    executed: !!r.txHash,
  }
}

/** Remote tx -> local PendingTx. Only plain ECDSA owner signatures are carried over (on-chain approvals are read from the Safe). */
export function remoteToPending(r: RemoteTx): PendingTx {
  const signatures: Record<string, Hex> = {}
  for (const c of r.confirmations) {
    if ((c.signatureType === 'EOA' || c.signatureType === 'ETH_SIGN') && c.signature.length === 132) signatures[c.owner.toLowerCase()] = c.signature
  }
  const from = r.originName && r.originName !== 'Bread Safe' ? ` (from ${r.originName})` : ''
  return {
    chainId: r.chainId,
    safe: r.safe,
    safeTxHash: r.safeTxHash,
    tx: r.tx,
    description: (r.notes || 'Transaction') + from,
    createdAt: Date.now(),
    signatures,
  }
}

export async function fetchRemoteQueue(chainId: number, safe: Address): Promise<RemoteTx[]> {
  const res = await queueCall<{ results?: Record<string, unknown>[] }>(
    `/api/v1/multisig-transactions/queue?safes=${encodeURIComponent(`${safe}:${chainId}`)}`,
  )
  return (res.results ?? []).map(parseRemoteTx).filter((r): r is RemoteTx => !!r && r.chainId === chainId && !r.executed)
}

export async function fetchRemoteTx(safeTxHash: Hex): Promise<RemoteTx | undefined> {
  try {
    const r = await queueCall<Record<string, unknown>>(`/api/v1/multisig-transactions/${safeTxHash}`)
    return parseRemoteTx(r)
  } catch (e) {
    if ((e as { status?: number }).status === 404) return undefined
    throw e
  }
}

export async function proposeRemote(p: PendingTx, signatures: Hex[]): Promise<void> {
  await queueCall('/api/v1/multisig-transactions', {
    method: 'POST',
    body: JSON.stringify({
      chainId: p.chainId,
      safe: p.safe,
      ...p.tx,
      operation: p.tx.operation,
      signatures,
      originName: 'Bread Safe',
      originUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
      notes: p.description.slice(0, 200),
    }),
  })
}

export async function addRemoteSignatures(safeTxHash: Hex, signatures: Hex[]): Promise<void> {
  await queueCall(`/api/v1/multisig-transactions/${safeTxHash}/signatures`, { method: 'POST', body: JSON.stringify({ signatures }) })
}

/** Owners whose signature we hold locally but the shared queue does not have yet. */
export function missingRemotely(local: PendingTx, remote: RemoteTx | undefined): Hex[] {
  const have = new Set((remote?.confirmations ?? []).map((c) => c.owner.toLowerCase()))
  return Object.entries(local.signatures)
    .filter(([owner]) => !have.has(owner.toLowerCase()))
    .map(([, sig]) => sig)
}

/**
 * Make sure the shared queue has every signature we hold for this transaction:
 * propose it if it is new there, otherwise add the missing signatures.
 * Returns how many signatures were sent.
 */
export async function syncToRemote(local: PendingTx, remote?: RemoteTx | null): Promise<number> {
  const current = remote === undefined ? await fetchRemoteTx(local.safeTxHash) : (remote ?? undefined)
  const missing = missingRemotely(local, current)
  if (missing.length === 0) return 0
  if (!current) await proposeRemote(local, missing)
  else await addRemoteSignatures(local.safeTxHash, missing)
  return missing.length
}
