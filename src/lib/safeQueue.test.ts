import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { handleQueueRequest, parseAllowed } from '../server/queueProxy'
import { buildSafeTx, computeSafeTxHash, safeTxTypedData } from './safe'
import { missingRemotely, parseRemoteTx, remoteToPending } from './safeQueue'
import type { PendingTx } from './queue'

const SAFE = '0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad'
const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const owner2 = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')

describe('queue proxy', () => {
  const env = { SAFE_API_KEY: 'test-key' }
  const ok = () => vi.fn(async () => new Response('{"results":[]}', { status: 200, headers: { 'content-type': 'application/json' } }))

  it('refuses to run without a key', async () => {
    const res = await handleQueueRequest(new Request('https://x/api/safe-queue/api/v1/multisig-transactions/queue?safes=a'), {}, 'api/v1/multisig-transactions/queue')
    expect(res.status).toBe(503)
  })

  it('forwards the queue listing with the key added server-side', async () => {
    const f = ok()
    const res = await handleQueueRequest(
      new Request(`https://x/api/safe-queue/api/v1/multisig-transactions/queue?safes=${SAFE}:100`),
      env,
      'api/v1/multisig-transactions/queue',
      f as unknown as typeof fetch,
    )
    expect(res.status).toBe(200)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.safe.global/queue/api/v1/multisig-transactions/queue?safes=${encodeURIComponent(`${SAFE}:100`)}&nonceOrder=asc`)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
  })

  it('only forwards the four calls the app needs', async () => {
    const f = ok()
    for (const [method, path] of [
      ['GET', 'api/v1/safes/0x0'],
      ['DELETE', `api/v1/multisig-transactions/0x${'a'.repeat(64)}`],
      ['GET', 'api/v2/anything'],
      ['GET', 'api/v1/multisig-transactions/notahash'],
    ]) {
      const res = await handleQueueRequest(new Request(`https://x/${path}`, { method }), env, path, f as unknown as typeof fetch)
      expect(res.status).toBe(404)
    }
    expect(f).not.toHaveBeenCalled()
  })

  it('enforces ALLOWED_SAFES on listing and proposing', async () => {
    const f = ok()
    const env2 = { ...env, ALLOWED_SAFES: `100:${SAFE}` }
    const other = '0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A'
    const list = await handleQueueRequest(new Request(`https://x/q?safes=${other}:100`), env2, 'api/v1/multisig-transactions/queue', f as unknown as typeof fetch)
    expect(list.status).toBe(403)
    const wrongChain = await handleQueueRequest(new Request(`https://x/q?safes=${SAFE}:8453`), env2, 'api/v1/multisig-transactions/queue', f as unknown as typeof fetch)
    expect(wrongChain.status).toBe(403)
    const propose = await handleQueueRequest(
      new Request('https://x/p', { method: 'POST', body: JSON.stringify({ chainId: 100, safe: other, signatures: ['0x01'] }) }),
      env2,
      'api/v1/multisig-transactions',
      f as unknown as typeof fetch,
    )
    expect(propose.status).toBe(403)
    const allowedOk = await handleQueueRequest(new Request(`https://x/q?safes=${SAFE}:100`), env2, 'api/v1/multisig-transactions/queue', f as unknown as typeof fetch)
    expect(allowedOk.status).toBe(200)
    expect(parseAllowed(`${SAFE}, 8453:${other}`)).toEqual([{ safe: SAFE.toLowerCase() }, { chainId: 8453, safe: other.toLowerCase() }])
  })

  it('strips unknown fields from proposals', async () => {
    const f = ok()
    await handleQueueRequest(
      new Request('https://x/p', { method: 'POST', body: JSON.stringify({ chainId: 100, safe: SAFE, signatures: ['0x01'], to: SAFE, evil: 1 }) }),
      env,
      'api/v1/multisig-transactions',
      f as unknown as typeof fetch,
    )
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ chainId: 100, safe: SAFE, signatures: ['0x01'], to: SAFE })
  })
})

describe('queue client mapping', () => {
  const tx = buildSafeTx({ to: SAFE, value: 5n, nonce: 268n })
  const hash = computeSafeTxHash(100, SAFE, tx)

  it('parses a Queue Service transaction and keeps only ECDSA owner signatures', async () => {
    const sig = await owner.signTypedData(safeTxTypedData(100, SAFE, tx))
    const remote = parseRemoteTx({
      chainId: 100,
      safe: SAFE,
      safeTxHash: hash,
      ...tx,
      operation: 0,
      nonce: 268,
      txHash: null,
      notes: 'Pay rent',
      originName: 'Safe{Wallet}',
      confirmations: [
        { owner: owner.address, signature: sig, signatureType: 'EOA' },
        { owner: owner2.address, signature: '0x' + '00'.repeat(65), signatureType: 'APPROVED_HASH' },
      ],
    })!
    expect(remote.tx).toEqual(tx)
    const p = remoteToPending(remote)
    expect(computeSafeTxHash(100, SAFE, p.tx)).toBe(hash)
    expect(Object.keys(p.signatures)).toEqual([owner.address.toLowerCase()])
    expect(p.description).toBe('Pay rent (from Safe{Wallet})')
  })

  it('rejects malformed transactions', () => {
    expect(parseRemoteTx({ safe: 'nope' })).toBeUndefined()
    expect(parseRemoteTx({ safe: SAFE, safeTxHash: hash, to: SAFE, operation: 5 })).toBeUndefined()
  })

  it('works out which local signatures the shared queue is missing', () => {
    const a = ('0x' + 'aa'.repeat(65)) as Hex
    const b = ('0x' + 'bb'.repeat(65)) as Hex
    const local: PendingTx = {
      chainId: 100,
      safe: SAFE,
      safeTxHash: hash,
      tx,
      description: '',
      createdAt: 0,
      signatures: { [owner.address.toLowerCase()]: a, [owner2.address.toLowerCase()]: b },
    }
    expect(missingRemotely(local, undefined)).toEqual([a, b])
    const remote = parseRemoteTx({ chainId: 100, safe: SAFE, safeTxHash: hash, ...tx, confirmations: [{ owner: owner.address, signature: a, signatureType: 'EOA' }] })
    expect(missingRemotely(local, remote)).toEqual([b])
  })
})
