/**
 * Proposers ("delegates" in Safe's API): addresses an owner authorizes to put transactions in the
 * Safe's shared queue. A proposer cannot sign or confirm; owners still have to reach the threshold.
 * Stored in Safe's Queue Service, so Safe{Wallet} shows the same proposers.
 *
 * Add/remove requests are authorized with an EIP-712 signature (domain "Safe Queue Service" v1.0 with
 * a non-standard `safe` field, type Delegate{delegateAddress, totp, action}, totp = unix hours).
 */
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from 'viem'
import { queueCall } from './safeQueue'

export interface Proposer {
  delegate: Address
  delegator: Address
  safe: Address | null
  /** null = valid on every chain */
  chainId: number | null
  label: string
}

export type DelegateAction = 'add' | 'edit' | 'delete'

export const ZERO: Address = '0x0000000000000000000000000000000000000000'

export function totp(nowMs = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000 / 3600))
}

/** Typed data an owner (or, for delete, the proposer) signs. chainId 0 / zero safe mean "all". */
export function delegateTypedData(p: { delegate: Address; chainId: number | null; safe: Address | null; action: DelegateAction; nowMs?: number }) {
  return {
    domain: { name: 'Safe Queue Service', version: '1.0', chainId: p.chainId ?? 0, safe: p.safe ?? ZERO },
    types: {
      // Spelled out because `safe` is not a standard EIP712Domain field.
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'safe', type: 'address' },
      ],
      Delegate: [
        { name: 'delegateAddress', type: 'address' },
        { name: 'totp', type: 'uint256' },
        { name: 'action', type: 'string' },
      ],
    },
    primaryType: 'Delegate' as const,
    message: { delegateAddress: p.delegate, totp: totp(p.nowMs), action: p.action },
  }
}

function parse(d: Record<string, unknown>): Proposer | undefined {
  if (!isAddress(String(d.delegate)) || !isAddress(String(d.delegator))) return undefined
  return {
    delegate: getAddress(String(d.delegate)),
    delegator: getAddress(String(d.delegator)),
    safe: isAddress(String(d.safe)) ? getAddress(String(d.safe)) : null,
    chainId: d.chainId === null || d.chainId === undefined || Number(d.chainId) === 0 ? null : Number(d.chainId),
    label: typeof d.label === 'string' ? d.label : '',
  }
}

type ListResponse = { results?: Record<string, unknown>[] } | Record<string, unknown>[]
const results = (r: ListResponse) => (Array.isArray(r) ? r : (r.results ?? []))

/**
 * Proposers that apply to this Safe on this chain: set for this Safe (any or this chain) by a
 * current owner. Delegator-wide proposers (no Safe) are not listed here.
 */
export async function listProposers(chainId: number, safe: Address, owners: Address[]): Promise<Proposer[]> {
  const res = await queueCall<ListResponse>(`/api/v1/delegates?safe=${safe}&limit=100`)
  return results(res)
    .map(parse)
    .filter((p): p is Proposer => !!p && (p.chainId === null || p.chainId === chainId) && owners.some((o) => isAddressEqual(o, p.delegator)))
}

/** Is `account` allowed to propose for this Safe on this chain (including delegator-wide entries)? */
export async function isProposerFor(chainId: number, safe: Address, owners: Address[], account: Address): Promise<boolean> {
  const res = await queueCall<ListResponse>(`/api/v1/delegates?delegate=${account}&limit=100`)
  return results(res)
    .map(parse)
    .some(
      (p) =>
        !!p &&
        (p.safe === null || isAddressEqual(p.safe, safe)) &&
        (p.chainId === null || p.chainId === chainId) &&
        owners.some((o) => isAddressEqual(o, p.delegator)),
    )
}

export async function addProposer(p: { delegate: Address; delegator: Address; safe: Address; chainId: number | null; label: string; signature: Hex }) {
  await queueCall('/api/v1/delegates', {
    method: 'POST',
    body: JSON.stringify({ delegate: p.delegate, delegator: p.delegator, safe: p.safe, chainId: p.chainId, label: p.label.slice(0, 50), signature: p.signature }),
  })
}

export async function removeProposer(p: { delegate: Address; delegator: Address; safe: Address | null; chainId: number | null; signature: Hex }) {
  await queueCall('/api/v1/delegates', {
    method: 'DELETE',
    body: JSON.stringify({ delegate: p.delegate, delegator: p.delegator, safe: p.safe, chainId: p.chainId, signature: p.signature }),
  })
}
