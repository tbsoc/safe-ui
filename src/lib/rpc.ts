import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { chainById, type ChainConfig } from './chains'
import { storage } from './storage'

const RPC_OVERRIDE_KEY = 'rpcOverrides'

export function getRpcOverrides(): Record<number, string> {
  return storage.get<Record<number, string>>(RPC_OVERRIDE_KEY, {})
}

export function setRpcOverride(chainId: number, url: string | undefined) {
  const all = getRpcOverrides()
  if (url) all[chainId] = url
  else delete all[chainId]
  storage.set(RPC_OVERRIDE_KEY, all)
  clients.delete(chainId)
}

/** Build-time override, e.g. VITE_RPC_URL_8453=https://… (also used by the fork tests). */
function envRpc(chainId: number): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  return env?.[`VITE_RPC_URL_${chainId}`] || undefined
}

export function rpcUrls(chain: ChainConfig): string[] {
  const override = getRpcOverrides()[chain.id] ?? envRpc(chain.id)
  return override ? [override] : chain.rpcs
}

const clients = new Map<number, PublicClient>()

export function getClient(chainId: number): PublicClient {
  const existing = clients.get(chainId)
  if (existing) return existing
  const chain = chainById(chainId)
  if (!chain) throw new Error(`Unsupported chain ${chainId}`)
  const client = createPublicClient({
    chain: chain.chain,
    transport: fallback(rpcUrls(chain).map((url) => http(url, { batch: { wait: 16 } }))),
  }) as PublicClient
  clients.set(chainId, client)
  return client
}
