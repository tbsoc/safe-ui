import type { Address, Hex } from 'viem'
import type { SafeTx } from './safe'
import { storage } from './storage'

/** A proposed Safe transaction plus the off-chain signatures collected so far. */
export interface PendingTx {
  chainId: number
  safe: Address
  safeTxHash: Hex
  tx: SafeTx
  description: string
  createdAt: number
  /** lowercased owner address -> 65-byte signature */
  signatures: Record<string, Hex>
}

const key = (chainId: number, safe: string) => `queue:${chainId}:${safe.toLowerCase()}`

export function loadQueue(chainId: number, safe: Address): PendingTx[] {
  return storage.get<PendingTx[]>(key(chainId, safe), [])
}

export function saveQueue(chainId: number, safe: Address, queue: PendingTx[]) {
  storage.set(key(chainId, safe), queue)
}

/** Add or merge a pending tx (signatures are unioned when the same safeTxHash already exists). */
export function upsertPending(queue: PendingTx[], incoming: PendingTx): PendingTx[] {
  const idx = queue.findIndex((p) => p.safeTxHash === incoming.safeTxHash)
  if (idx < 0) return [...queue, incoming]
  const existing = queue[idx]
  const merged: PendingTx = {
    ...existing,
    description: existing.description || incoming.description,
    signatures: { ...existing.signatures, ...incoming.signatures },
  }
  const out = [...queue]
  out[idx] = merged
  return out
}
