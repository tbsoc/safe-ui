import { createPublicClient, http, type Address } from 'viem'
import { safeAbi } from '../lib/abis'
import { chainById } from '../lib/chains'

/** Read a Safe's current owners over public RPC (used by the address book to check editors). */
export function ownersLookup(rpcOverride?: (chainId: number) => string | undefined) {
  return async (chainId: number, safe: Address): Promise<Address[]> => {
    const chain = chainById(chainId)
    if (!chain) throw new Error(`Unsupported chain ${chainId}`)
    let lastError: unknown
    for (const url of rpcOverride?.(chainId) ? [rpcOverride(chainId)!] : chain.rpcs) {
      try {
        const client = createPublicClient({ chain: chain.chain, transport: http(url, { timeout: 10_000 }) })
        return [...(await client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }))]
      } catch (e) {
        lastError = e
      }
    }
    throw lastError
  }
}
