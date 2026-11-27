import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { safeAbi } from '../lib/abis'
import { CHAINS, type ChainConfig } from '../lib/chains'
import { getClient } from '../lib/rpc'
import { isHiddenSafe } from '../lib/hidden'

interface Sibling {
  chain: ChainConfig
  threshold: number
  owners: number
}

/**
 * Safes are often deployed at the same address on several chains, but each copy has its own
 * signers and threshold. List the other chains where this address is a Safe, with their threshold.
 */
async function findSiblings(current: number, address: Address): Promise<Sibling[]> {
  const results = await Promise.all(
    CHAINS.filter((c) => c.id !== current && !isHiddenSafe(c.id, address)).map(async (chain) => {
      try {
        const client = getClient(chain.id)
        const code = await client.getCode({ address })
        if (!code || code === '0x') return undefined
        const [threshold, owners] = await Promise.all([
          client.readContract({ address, abi: safeAbi, functionName: 'getThreshold' }),
          client.readContract({ address, abi: safeAbi, functionName: 'getOwners' }),
        ])
        return { chain, threshold: Number(threshold), owners: owners.length }
      } catch {
        return undefined // not a Safe there, or RPC unavailable
      }
    }),
  )
  return results.filter((r): r is Sibling => !!r)
}

export function OtherChains({ chainId, address, onOpen }: { chainId: number; address: Address; onOpen: (chain: ChainConfig) => void }) {
  const q = useQuery({ queryKey: ['siblings', chainId, address], queryFn: () => findSiblings(chainId, address), staleTime: 5 * 60_000 })
  if (!q.data || q.data.length === 0) return null
  return (
    <div className="siblings small">
      <span className="muted">Same address on:</span>
      {q.data.map((s) => (
        <button
          key={s.chain.id}
          type="button"
          className="sibling"
          onClick={() => onOpen(s.chain)}
          title={s.threshold === 1 ? 'A single signer can move funds on this chain' : `${s.threshold} of ${s.owners} signers required`}
        >
          {s.chain.name} <span className={s.threshold === 1 ? 'tag warn' : 'tag'}>{s.threshold} of {s.owners}</span>
        </button>
      ))}
      <span className="muted">Each chain has its own signers.</span>
    </div>
  )
}
