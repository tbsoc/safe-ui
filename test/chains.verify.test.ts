/**
 * Live check of the chain config against each real chain (npm run verify:chains).
 * Every RPC must answer with the right chain id, every listed token must match its symbol and
 * decimals, every Allowance Module version must be deployed exactly where the config says, and
 * MultiSendCallOnly must exist everywhere.
 */
import { createPublicClient, http } from 'viem'
import { describe, expect, it } from 'vitest'
import { erc20Abi } from '../src/lib/abis'
import { CHAINS } from '../src/lib/chains'
import { ALLOWANCE_MODULES, MULTI_SEND_CALL_ONLY } from '../src/lib/constants'

const RUN = process.env.VERIFY_CHAINS === '1'

describe.runIf(RUN).each(CHAINS)('$name ($id)', (chain) => {
  const client = createPublicClient({ chain: chain.chain, transport: http(chain.rpcs[0], { timeout: 15_000 }) })

  it.each(chain.rpcs)('RPC %s answers with the right chain id', async (url) => {
    const c = createPublicClient({ chain: chain.chain, transport: http(url, { timeout: 15_000 }) })
    expect(await c.getChainId()).toBe(chain.id)
  })

  it.each(chain.tokens)('token $symbol matches on-chain symbol and decimals', async (t) => {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: t.address, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: t.address, abi: erc20Abi, functionName: 'decimals' }),
    ])
    expect(Number(decimals)).toBe(t.decimals)
    // Labels may add a suffix to tell twins apart ("USDC.e" for bridged USDC, "EURe (v1)").
    const onchain = symbol.replace('₮', 'T').toLowerCase()
    const label = t.symbol.toLowerCase()
    expect(label === onchain || label.startsWith(`${onchain}.`) || label.startsWith(`${onchain} (`)).toBe(true)
  })

  it.each(ALLOWANCE_MODULES)('Allowance Module v$version deployment matches the config', async (m) => {
    const code = await client.getCode({ address: m.address })
    const deployed = !!code && code !== '0x'
    expect(deployed).toBe(!m.missingOn?.includes(chain.id))
  })

  it('MultiSendCallOnly is deployed', async () => {
    const code = await client.getCode({ address: MULTI_SEND_CALL_ONLY })
    expect(code && code.length > 2).toBe(true)
  })
})
