import {
  concat,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddressEqual,
  pad,
  recoverAddress,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { safeAbi } from './abis'
import { SENTINEL, ZERO_ADDRESS } from './constants'
import { getClient } from './rpc'

/** A Safe transaction. Numbers are decimal strings so the object survives JSON and URLs. */
export interface SafeTx {
  to: Address
  value: string
  data: Hex
  operation: 0 | 1
  safeTxGas: string
  baseGas: string
  gasPrice: string
  gasToken: Address
  refundReceiver: Address
  nonce: string
}

export interface SafeInfo {
  chainId: number
  address: Address
  version: string
  owners: Address[]
  threshold: number
  nonce: bigint
  modules: Address[]
  nativeBalance: bigint
}

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

export function isSupportedSafeVersion(version: string): boolean {
  const [major, minor] = version.split('.').map((n) => parseInt(n, 10))
  return major === 1 && minor >= 3
}

export async function loadSafeInfo(chainId: number, address: Address): Promise<SafeInfo> {
  const client = getClient(chainId)
  const code = await client.getCode({ address })
  if (!code || code === '0x') throw new Error('No contract at this address on this chain.')
  const base = { address, abi: safeAbi } as const
  const [version, owners, threshold, nonce, nativeBalance] = await Promise.all([
    client.readContract({ ...base, functionName: 'VERSION' }),
    client.readContract({ ...base, functionName: 'getOwners' }),
    client.readContract({ ...base, functionName: 'getThreshold' }),
    client.readContract({ ...base, functionName: 'nonce' }),
    client.getBalance({ address }),
  ])
  const modules = await loadModules(chainId, address)
  return {
    chainId,
    address: getAddress(address),
    version,
    owners: [...owners],
    threshold: Number(threshold),
    nonce,
    modules,
    nativeBalance,
  }
}

export async function loadModules(chainId: number, safe: Address): Promise<Address[]> {
  const client = getClient(chainId)
  const modules: Address[] = []
  let start: Address = SENTINEL
  for (let i = 0; i < 20; i++) {
    const [page, next] = await client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: 'getModulesPaginated',
      args: [start, 50n],
    })
    modules.push(...page)
    if (isAddressEqual(next, SENTINEL) || isAddressEqual(next, ZERO_ADDRESS)) break
    start = next
  }
  return modules
}

export function buildSafeTx(params: {
  to: Address
  value?: bigint
  data?: Hex
  operation?: 0 | 1
  nonce: bigint
}): SafeTx {
  return {
    to: getAddress(params.to),
    value: (params.value ?? 0n).toString(),
    data: params.data ?? '0x',
    operation: params.operation ?? 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: params.nonce.toString(),
  }
}

export function typedSafeTx(tx: SafeTx) {
  return {
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
    operation: tx.operation,
    safeTxGas: BigInt(tx.safeTxGas),
    baseGas: BigInt(tx.baseGas),
    gasPrice: BigInt(tx.gasPrice),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: BigInt(tx.nonce),
  }
}

/** EIP-712 payload owners sign. Domain is the v1.3.0+ layout: {chainId, verifyingContract}. */
export function safeTxTypedData(chainId: number, safe: Address, tx: SafeTx) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx' as const,
    message: typedSafeTx(tx),
  }
}

export function computeSafeTxHash(chainId: number, safe: Address, tx: SafeTx): Hex {
  return hashTypedData(safeTxTypedData(chainId, safe, tx))
}

/** Ask the Safe itself for the hash, to cross-check the locally computed one. */
export async function fetchSafeTxHash(chainId: number, safe: Address, tx: SafeTx): Promise<Hex> {
  const t = typedSafeTx(tx)
  return getClient(chainId).readContract({
    address: safe,
    abi: safeAbi,
    functionName: 'getTransactionHash',
    args: [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, t.nonce],
  })
}

/** Some wallets/hardware return v as 0/1; the Safe expects 27/28 for plain ECDSA signatures. */
export function normalizeSignature(signature: Hex): Hex {
  if (signature.length !== 132) throw new Error('Expected a 65-byte signature')
  const v = parseInt(signature.slice(130), 16)
  if (v === 0 || v === 1) return (signature.slice(0, 130) + toHex(v + 27).slice(2)) as Hex
  if (v !== 27 && v !== 28) throw new Error(`Unsupported signature v=${v}`)
  return signature
}

export async function recoverSigner(safeTxHash: Hex, signature: Hex): Promise<Address> {
  return getAddress(await recoverAddress({ hash: safeTxHash, signature: normalizeSignature(signature) }))
}

/** Signature that tells the Safe "this owner approved on-chain, or is the one executing". */
export function approvedHashSignature(owner: Address): Hex {
  return concat([pad(owner, { size: 32 }), pad('0x00', { size: 32 }), '0x01'])
}

export interface SignatureEntry {
  signer: Address
  data: Hex
}

/** Safe requires signatures sorted by signer address, ascending. */
export function packSignatures(entries: SignatureEntry[]): Hex {
  const sorted = [...entries].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
  return concat(sorted.map((e) => e.data))
}

export interface ExecutionPlan {
  ready: boolean
  /** Owners whose confirmation is counted (off-chain signature, on-chain approval or executor). */
  confirmedBy: Address[]
  entries: SignatureEntry[]
  missing: number
}

export function planExecution(params: {
  owners: Address[]
  threshold: number
  signatures: Record<string, Hex>
  onchainApprovals: Address[]
  executor?: Address
}): ExecutionPlan {
  const { owners, threshold, signatures, onchainApprovals, executor } = params
  const entries: SignatureEntry[] = []
  for (const owner of owners) {
    const key = owner.toLowerCase()
    if (signatures[key]) entries.push({ signer: owner, data: normalizeSignature(signatures[key]) })
    else if (onchainApprovals.some((a) => isAddressEqual(a, owner))) entries.push({ signer: owner, data: approvedHashSignature(owner) })
    else if (executor && isAddressEqual(executor, owner)) entries.push({ signer: owner, data: approvedHashSignature(owner) })
  }
  const used = entries.slice(0, threshold)
  return {
    ready: entries.length >= threshold,
    confirmedBy: entries.map((e) => e.signer),
    entries: used,
    missing: Math.max(0, threshold - entries.length),
  }
}

export async function loadOnchainApprovals(chainId: number, safe: Address, owners: Address[], safeTxHash: Hex) {
  const client = getClient(chainId)
  const results = await Promise.all(
    owners.map((owner) =>
      client.readContract({ address: safe, abi: safeAbi, functionName: 'approvedHashes', args: [owner, safeTxHash] }),
    ),
  )
  return owners.filter((_, i) => results[i] > 0n)
}

export function execTransactionArgs(tx: SafeTx, signatures: Hex) {
  const t = typedSafeTx(tx)
  return [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, signatures] as const
}

export function encodeExecTransaction(tx: SafeTx, signatures: Hex): Hex {
  return encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: execTransactionArgs(tx, signatures) })
}
