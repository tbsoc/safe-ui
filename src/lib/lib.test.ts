import { privateKeyToAccount } from 'viem/accounts'
import { decodeFunctionData, encodeFunctionData, getAddress, parseEther, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { allowanceModuleAbi, multiSendAbi, safeAbi } from './abis'
import { activeModule, describePeriod, nextResetAt, setAllowanceCalls, type Allowance } from './allowances'
import { MAX_UINT96, MULTI_SEND_CALL_ONLY, STANDARD_ALLOWANCE_MODULE } from './constants'
import { decodeSafeTx } from './decode'
import { formatAmount, parseAmount } from './format'
import { batchCalls, decodeMultiSendTransactions, encodeMultiSendTransactions } from './multisend'
import { decodePending, encodePending, extractEncoded, upsertPending, type PendingTx } from './queue'
import {
  approvedHashSignature,
  buildSafeTx,
  computeSafeTxHash,
  normalizeSignature,
  packSignatures,
  planExecution,
  recoverSigner,
  safeTxTypedData,
} from './safe'

const SAFE: Address = '0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A'
const keys: Hex[] = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]
const accounts = keys.map((k) => privateKeyToAccount(k))
const owners = accounts.map((a) => a.address)

describe('multisend', () => {
  it('round-trips packed transactions', () => {
    const calls = [
      { to: SAFE, data: '0x12345678' as Hex },
      { to: owners[0], value: 5n, data: '0x' as Hex },
    ]
    const decoded = decodeMultiSendTransactions(encodeMultiSendTransactions(calls))
    expect(decoded).toHaveLength(2)
    expect(getAddress(decoded[0].to)).toBe(SAFE)
    expect(decoded[0].data).toBe('0x12345678')
    expect(decoded[1].value).toBe(5n)
    expect(decoded[1].data).toBe('0x')
  })

  it('sends one call directly and batches several through MultiSendCallOnly', () => {
    const one = batchCalls([{ to: SAFE, data: '0xabcdef01' }])
    expect(one).toEqual({ to: SAFE, value: 0n, data: '0xabcdef01', operation: 0 })
    const many = batchCalls([
      { to: SAFE, data: '0xabcdef01' },
      { to: SAFE, data: '0xabcdef02' },
    ])
    expect(many.to).toBe(MULTI_SEND_CALL_ONLY)
    expect(many.operation).toBe(1)
    const { functionName } = decodeFunctionData({ abi: multiSendAbi, data: many.data })
    expect(functionName).toBe('multiSend')
  })
})

describe('signatures', () => {
  const tx = buildSafeTx({ to: owners[0], value: 1n, nonce: 0n })
  const hash = computeSafeTxHash(8453, SAFE, tx)

  it('recovers EIP-712 signatures to the signing owner', async () => {
    const sig = await accounts[0].signTypedData(safeTxTypedData(8453, SAFE, tx))
    expect(await recoverSigner(hash, sig)).toBe(owners[0])
  })

  it('normalizes v=0/1 to 27/28 and rejects other v values', async () => {
    const sig = await accounts[1].signTypedData(safeTxTypedData(8453, SAFE, tx))
    const v = parseInt(sig.slice(130), 16)
    const low = (sig.slice(0, 130) + (v - 27).toString(16).padStart(2, '0')) as Hex
    expect(normalizeSignature(low)).toBe(sig)
    expect(() => normalizeSignature((sig.slice(0, 130) + '1f') as Hex)).toThrow()
  })

  it('packs signatures sorted by signer address', () => {
    const entries = owners.map((o, i) => ({ signer: o, data: (`0x${String(i).repeat(130)}`) as Hex }))
    const sortedOwners = [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
    const packed = packSignatures(entries)
    sortedOwners.forEach((o, pos) => {
      const i = owners.indexOf(o)
      expect(packed.slice(2 + pos * 130, 2 + (pos + 1) * 130)).toBe(String(i).repeat(130))
    })
  })

  it('encodes approved-hash signatures as r=owner, s=0, v=1', () => {
    const s = approvedHashSignature(owners[0])
    expect(s.length).toBe(132)
    expect(s.slice(26, 66).toLowerCase()).toBe(owners[0].slice(2).toLowerCase())
    expect(s.slice(-2)).toBe('01')
  })

  it('plans execution from off-chain sigs, on-chain approvals and the executor', () => {
    const base = { owners, threshold: 3, onchainApprovals: [] as Address[] }
    const sigs = { [owners[0].toLowerCase()]: ('0x' + 'aa'.repeat(64) + '1b') as Hex }
    expect(planExecution({ ...base, signatures: sigs }).missing).toBe(2)
    const withApproval = planExecution({ ...base, signatures: sigs, onchainApprovals: [owners[1]] })
    expect(withApproval.missing).toBe(1)
    const full = planExecution({ ...base, signatures: sigs, onchainApprovals: [owners[1]], executor: owners[2] })
    expect(full.ready).toBe(true)
    expect(full.entries).toHaveLength(3)
  })
})

describe('allowance calls', () => {
  const delegate = owners[2]
  const token = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address

  it('enables the module and adds the delegate when needed', () => {
    const calls = setAllowanceCalls({ safe: SAFE, modules: [], delegates: [], delegate, token, amount: 100n, resetTimeMin: 43200 })
    expect(calls).toHaveLength(3)
    expect(decodeFunctionData({ abi: safeAbi, data: calls[0].data }).functionName).toBe('enableModule')
    expect(calls[0].to).toBe(SAFE)
    expect(decodeFunctionData({ abi: allowanceModuleAbi, data: calls[1].data }).functionName).toBe('addDelegate')
    const set = decodeFunctionData({ abi: allowanceModuleAbi, data: calls[2].data })
    expect(set.functionName).toBe('setAllowance')
    expect(set.args).toEqual([delegate, token, 100n, 43200, 0])
    expect(calls[1].to).toBe(STANDARD_ALLOWANCE_MODULE.address)
  })

  it('only sets the allowance when module and delegate already exist', () => {
    const calls = setAllowanceCalls({
      safe: SAFE,
      modules: [STANDARD_ALLOWANCE_MODULE.address],
      delegates: [delegate],
      delegate,
      token,
      amount: 1n,
      resetTimeMin: 0,
    })
    expect(calls).toHaveLength(1)
  })

  it('uses an already-enabled legacy module instead of adding a second one', () => {
    const legacy = '0xAA46724893dedD72658219405185Fb0Fc91e091C' as Address
    const calls = setAllowanceCalls({ safe: SAFE, modules: [legacy], delegates: [], delegate, token, amount: 1n, resetTimeMin: 0 })
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.to === legacy)).toBe(true)
  })

  it('prefers the newest enabled legacy module when several are enabled', () => {
    const both = ['0xAA46724893dedD72658219405185Fb0Fc91e091C', '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134'] as Address[]
    expect(activeModule(both).deployment.version).toBe('0.1.1')
    expect(activeModule([both[1]]).deployment.version).toBe('0.1.0')
    expect(activeModule([]).deployment.version).toBe('1.0.0')
    expect(activeModule([...both, STANDARD_ALLOWANCE_MODULE.address]).deployment.version).toBe('1.0.0')
    // An explicit module override is honoured (used when editing an allowance on an older module).
    const calls = setAllowanceCalls({ safe: SAFE, modules: both, delegates: [delegate], delegate, token, amount: 1n, resetTimeMin: 0, module: both[1] })
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toBe(both[1])
  })

  it('validates amount and period bounds', () => {
    const base = { safe: SAFE, modules: [], delegates: [], delegate, token }
    expect(() => setAllowanceCalls({ ...base, amount: 0n, resetTimeMin: 0 })).toThrow()
    expect(() => setAllowanceCalls({ ...base, amount: MAX_UINT96 + 1n, resetTimeMin: 0 })).toThrow()
    expect(() => setAllowanceCalls({ ...base, amount: 1n, resetTimeMin: 65536 })).toThrow()
    expect(() => setAllowanceCalls({ ...base, amount: 1n, resetTimeMin: 60, resetBaseMin: Math.floor(Date.now() / 60000) + 100 })).toThrow()
  })

  it('computes the next reset and describes periods', () => {
    const a: Allowance = { module: STANDARD_ALLOWANCE_MODULE.address, delegate, token, amount: 1n, spent: 0n, resetTimeMin: 1440, lastResetMin: 1000, nonce: 1 }
    expect(nextResetAt(a, (1000 + 10) * 60)).toBe((1000 + 1440) * 60)
    expect(nextResetAt(a, (1000 + 1440 * 2 + 5) * 60)).toBe((1000 + 1440 * 3) * 60)
    expect(nextResetAt({ ...a, resetTimeMin: 0 })).toBeUndefined()
    expect(describePeriod(43200)).toBe('Every 30 days')
    expect(describePeriod(10080)).toBe('Weekly')
    expect(describePeriod(0)).toBe('One-time')
  })

  it('decodes a batched setup transaction for review', () => {
    const calls = setAllowanceCalls({ safe: SAFE, modules: [], delegates: [], delegate, token, amount: 100n, resetTimeMin: 1440 })
    const b = batchCalls(calls)
    const tx = buildSafeTx({ ...b, nonce: 0n })
    const decoded = decodeSafeTx(SAFE, tx, [{ address: token, symbol: 'USDC', decimals: 6 }])
    expect(decoded.map((d) => d.functionName)).toEqual(['enableModule', 'addDelegate', 'setAllowance'])
    expect(decoded[2].args?.find((a) => a.name === 'allowanceAmount')?.value).toBe('100 (= 0.0001 USDC)')
    expect(decoded[1].label).toContain('Allowance Module v1.0.0')
  })
})

describe('share links', () => {
  const tx = buildSafeTx({
    to: SAFE,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'changeThreshold', args: [2n] }),
    nonce: 4n,
  })
  const p: PendingTx = {
    chainId: 8453,
    safe: SAFE,
    safeTxHash: computeSafeTxHash(8453, SAFE, tx),
    tx,
    description: 'Lower threshold',
    createdAt: 1,
    signatures: { [owners[0].toLowerCase()]: ('0x' + 'ab'.repeat(65)) as Hex },
  }

  it('round-trips through the URL fragment', () => {
    const link = `https://example.org/?safe=base:${SAFE}#tx=${encodePending(p)}`
    expect(decodePending(extractEncoded(link))).toEqual(p)
  })

  it('rejects malformed payloads', () => {
    expect(() => decodePending('not-base64')).toThrow()
    const bad = encodePending({ ...p, tx: { ...p.tx, to: 'nope' as Address } })
    expect(() => decodePending(bad)).toThrow()
  })

  it('merges signatures for the same transaction', () => {
    const other = { ...p, signatures: { [owners[1].toLowerCase()]: ('0x' + 'cd'.repeat(65)) as Hex } }
    const q = upsertPending([p], other)
    expect(q).toHaveLength(1)
    expect(Object.keys(q[0].signatures)).toHaveLength(2)
  })
})

describe('amounts', () => {
  it('parses and formats', () => {
    expect(parseAmount('1.5', 6)).toBe(1_500_000n)
    expect(parseAmount('1,000', 18)).toBe(parseEther('1000'))
    expect(parseAmount('1.1234567', 6)).toBeUndefined()
    expect(parseAmount('abc', 6)).toBeUndefined()
    expect(formatAmount(1_234_567_890n, 6)).toBe('1,234.5678')
    expect(formatAmount(1n, 18)).toBe('<0.0001')
    expect(formatAmount(0n, 18)).toBe('0')
  })
})
