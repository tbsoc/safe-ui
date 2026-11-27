import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { nameTypedData } from '../lib/names'
import { handleNamesRequest, memoryKV, parseEditors } from './names'

const SAFE = '0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad'
const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const outsider = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const member = '0x00000000000000000000000000000000000a11ce' as Address
const lookup = async () => [signer.address]

async function post(env: Parameters<typeof handleNamesRequest>[1], account = signer, name = 'Alice', ts = Math.floor(Date.now() / 1000), now = Date.now()) {
  const signature = await account.signTypedData(nameTypedData(member, name, ts))
  return handleNamesRequest(
    new Request('https://x/api/names', { method: 'POST', body: JSON.stringify({ address: member, name, timestamp: ts, signer: account.address, signature }) }),
    env,
    lookup,
    now,
  )
}
const get = async (env: Parameters<typeof handleNamesRequest>[1]) =>
  (await (await handleNamesRequest(new Request('https://x/api/names'), env, lookup)).json()) as { names: Record<string, { name: string; by: string }> }

describe('shared address book', () => {
  it('lets a signer of an editor Safe set, change and remove a name', async () => {
    const env = { NAMES: memoryKV(), NAME_EDITORS: `100:${SAFE}` }
    expect((await post(env)).status).toBe(200)
    expect((await get(env)).names[member.toLowerCase()]).toMatchObject({ name: 'Alice', by: signer.address })
    expect((await post(env, signer, 'Alice (treasurer)')).status).toBe(200)
    expect((await get(env)).names[member.toLowerCase()].name).toBe('Alice (treasurer)')
    expect((await post(env, signer, '')).status).toBe(200)
    expect((await get(env)).names[member.toLowerCase()]).toBeUndefined()
  })

  it('refuses people who are not signers', async () => {
    const env = { NAMES: memoryKV(), NAME_EDITORS: `100:${SAFE}` }
    expect((await post(env, outsider)).status).toBe(403)
    expect((await get(env)).names).toEqual({})
  })

  it('refuses forged, stale and oversized requests', async () => {
    const env = { NAMES: memoryKV(), NAME_EDITORS: `100:${SAFE}` }
    const ts = Math.floor(Date.now() / 1000)
    const forged = await outsider.signTypedData(nameTypedData(member, 'Mallory', ts))
    const res = await handleNamesRequest(
      new Request('https://x/api/names', { method: 'POST', body: JSON.stringify({ address: member, name: 'Mallory', timestamp: ts, signer: signer.address, signature: forged }) }),
      env,
      lookup,
    )
    expect(res.status).toBe(401)
    expect((await post(env, signer, 'Alice', ts - 3600)).status).toBe(400)
    expect((await post(env, signer, 'x'.repeat(65))).status).toBe(400)
  })

  it('needs editor Safes and a KV binding', async () => {
    expect((await post({ NAMES: memoryKV(), NAME_EDITORS: '' })).status).toBe(403)
    expect((await handleNamesRequest(new Request('https://x/api/names'), {}, lookup)).status).toBe(503)
    expect(parseEditors(`100:${SAFE}, 1:0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A, bogus`)).toHaveLength(2)
  })
})
