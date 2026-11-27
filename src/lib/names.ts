/** Client for the shared address book (/api/names on this site; see src/server/names.ts). */
import { getAddress, type Address, type Hex } from 'viem'
import { NAME_TYPED_DATA, type NameEntry } from '../server/names'

export type { NameEntry }
export { MAX_NAME } from '../server/names'

export class NamesUnavailableError extends Error {}

export async function fetchNames(): Promise<Record<string, NameEntry>> {
  let res: Response
  try {
    res = await fetch('/api/names')
  } catch {
    throw new NamesUnavailableError('Address book unreachable')
  }
  if (res.status === 503 || !(res.headers.get('content-type') ?? '').includes('json')) throw new NamesUnavailableError('Address book not configured')
  if (!res.ok) throw new Error(`Address book error ${res.status}`)
  return ((await res.json()) as { names: Record<string, NameEntry> }).names
}

export function nameTypedData(address: Address, name: string, timestamp: number) {
  return { ...NAME_TYPED_DATA, message: { address: getAddress(address), name: name.trim(), timestamp: BigInt(timestamp) } }
}

export async function saveName(p: { address: Address; name: string; timestamp: number; signer: Address; signature: Hex }) {
  const res = await fetch('/api/names', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...p, name: p.name.trim() }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Address book error ${res.status}`)
}
