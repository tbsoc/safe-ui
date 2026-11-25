import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
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

// ---- Share links -------------------------------------------------------------------------
// The whole pending tx travels in the URL fragment (never sent to any server).
// It is encoded, not encrypted: anyone with the link can read the transaction.

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export function encodePending(p: PendingTx): string {
  return toBase64Url(JSON.stringify({ v: 1, ...p }))
}

/** Parse and shape-check a shared payload. The caller must still verify hash and signatures. */
export function decodePending(encoded: string): PendingTx {
  const o = JSON.parse(fromBase64Url(encoded))
  const tx = o?.tx
  const num = (x: unknown) => typeof x === 'string' && /^\d+$/.test(x)
  if (
    o?.v !== 1 ||
    typeof o.chainId !== 'number' ||
    !isAddress(o.safe) ||
    !isHex(o.safeTxHash) ||
    !tx ||
    !isAddress(tx.to) ||
    !isHex(tx.data) ||
    !(tx.operation === 0 || tx.operation === 1) ||
    ![tx.value, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.nonce].every(num) ||
    !isAddress(tx.gasToken) ||
    !isAddress(tx.refundReceiver)
  ) {
    throw new Error('This link does not contain a valid transaction')
  }
  const signatures: Record<string, Hex> = {}
  for (const [k, v] of Object.entries(o.signatures ?? {})) {
    if (isAddress(k) && isHex(v) && (v as string).length === 132) signatures[k.toLowerCase()] = v as Hex
  }
  return {
    chainId: o.chainId,
    safe: getAddress(o.safe),
    safeTxHash: o.safeTxHash,
    tx: {
      to: getAddress(tx.to),
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas,
      baseGas: tx.baseGas,
      gasPrice: tx.gasPrice,
      gasToken: getAddress(tx.gasToken),
      refundReceiver: getAddress(tx.refundReceiver),
      nonce: tx.nonce,
    },
    description: typeof o.description === 'string' ? o.description.slice(0, 500) : '',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    signatures,
  }
}

/** Accepts a full share URL or just the encoded part. */
export function extractEncoded(input: string): string {
  const trimmed = input.trim()
  const m = trimmed.match(/[#&]tx=([A-Za-z0-9_-]+)/)
  return m ? m[1] : trimmed
}
