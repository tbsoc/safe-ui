import type { Address } from 'viem'
import { chainByShortName } from './chains'

/**
 * Safes kept off the start screen (including "recently opened") and out of the "Same address on"
 * row. They still open if someone pastes the address. Format: "shortName:0xSafe".
 */
export const HIDDEN_SAFES = ['base:0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A']

export function isHiddenSafe(chainId: number, address: Address | string): boolean {
  return HIDDEN_SAFES.some((ref) => {
    const [short, addr] = ref.split(':')
    return chainByShortName(short)?.id === chainId && addr.toLowerCase() === address.toLowerCase()
  })
}

export function isHiddenRef(ref: string): boolean {
  const [short, addr] = ref.split(':')
  const chain = chainByShortName(short ?? '')
  return !!chain && !!addr && isHiddenSafe(chain.id, addr)
}
