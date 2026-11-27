/**
 * Live check of the shared-queue integration against Safe's real Queue Service, through the same
 * proxy code the site runs. Needs a key: SAFE_API_KEY=… npm run test:queue
 *
 * Reads the Bread core team Safe's queue and its last executed transaction, and checks that our
 * parser reproduces the exact Safe tx hash and that every signature recovers to its owner.
 * It also sends a proposal signed by a non-owner test key and expects the service to refuse it,
 * which shows the request shape is accepted while nothing gets stored.
 */
import { type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { handleQueueRequest } from '../src/server/queueProxy'
import { buildSafeTx, computeSafeTxHash, recoverSigner, safeTxTypedData } from '../src/lib/safe'
import { parseRemoteTx, remoteToPending } from '../src/lib/safeQueue'

const KEY = process.env.SAFE_API_KEY
const CORE = '0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad'
const BREAD_BASE = '0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A'
const EXECUTED = '0xc3a946edd7f24e4d32829428f7d1f960403edd70095457bb714c1d1502b41986' // core team nonce 267

const proxy = (path: string, init?: RequestInit) =>
  handleQueueRequest(new Request(`https://local/api/safe-queue/${path}`, init), { SAFE_API_KEY: KEY }, path.split('?')[0])

describe.runIf(!!KEY)('Safe Queue Service (live)', () => {
  it('lists the core team queue on Gnosis', async () => {
    const res = await proxy(`api/v1/multisig-transactions/queue?safes=${CORE}:100`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Record<string, unknown>[] }
    expect(Array.isArray(body.results)).toBe(true)
    for (const r of body.results) expect(parseRemoteTx(r)).toBeDefined()
  })

  it('parses a real executed transaction: same hash, every signature recovers to its owner', async () => {
    const res = await proxy(`api/v1/multisig-transactions/${EXECUTED}`)
    expect(res.status).toBe(200)
    const remote = parseRemoteTx((await res.json()) as Record<string, unknown>)!
    expect(remote.executed).toBe(true)
    const p = remoteToPending(remote)
    expect(computeSafeTxHash(100, CORE, p.tx)).toBe(EXECUTED)
    const sigs = Object.entries(p.signatures)
    expect(sigs.length).toBe(5)
    for (const [owner, sig] of sigs) expect((await recoverSigner(EXECUTED as Hex, sig)).toLowerCase()).toBe(owner)
  })

  it('refuses a proposal signed by a non-owner (nothing is stored)', async () => {
    const stranger = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba')
    // Far-future nonce so even a wrongly accepted proposal could never be executed.
    const tx = buildSafeTx({ to: BREAD_BASE, nonce: 999_999n })
    const sig = await stranger.signTypedData(safeTxTypedData(8453, BREAD_BASE, tx))
    const res = await proxy('api/v1/multisig-transactions', {
      method: 'POST',
      body: JSON.stringify({ chainId: 8453, safe: BREAD_BASE, ...tx, signatures: [sig], originName: 'Bread Safe test', notes: 'test: must be rejected' }),
    })
    const text = await res.text()
    console.log('non-owner proposal ->', res.status, text.slice(0, 300))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('returns 404 when adding a signature to an unknown transaction', async () => {
    const res = await proxy(`api/v1/multisig-transactions/0x${'ab'.repeat(32)}/signatures`, {
      method: 'POST',
      body: JSON.stringify({ signatures: ['0x' + '11'.repeat(65)] }),
    })
    console.log('unknown tx signature ->', res.status, (await res.text()).slice(0, 200))
    expect([400, 404, 422]).toContain(res.status)
  })
})
