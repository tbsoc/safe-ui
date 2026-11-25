import { getAddress, isAddressEqual, type Address } from 'viem'
import { erc20Abi } from './abis'
import { chainById, NATIVE_TOKEN, nativeToken, type TokenInfo } from './chains'
import { getClient } from './rpc'
import { storage } from './storage'

const customKey = (chainId: number) => `customTokens:${chainId}`

export function getCustomTokens(chainId: number): TokenInfo[] {
  return storage.get<TokenInfo[]>(customKey(chainId), [])
}

export function addCustomToken(chainId: number, token: TokenInfo) {
  const list = getCustomTokens(chainId).filter((t) => !isAddressEqual(t.address, token.address))
  storage.set(customKey(chainId), [...list, token])
}

export function removeCustomToken(chainId: number, address: Address) {
  storage.set(
    customKey(chainId),
    getCustomTokens(chainId).filter((t) => !isAddressEqual(t.address, address)),
  )
}

/** Native token + built-in list + user-added tokens. */
export function tokenList(chainId: number): TokenInfo[] {
  const chain = chainById(chainId)
  if (!chain) return []
  const builtIn = chain.tokens
  const custom = getCustomTokens(chainId).filter((c) => !builtIn.some((b) => isAddressEqual(b.address, c.address)))
  return [nativeToken(chain), ...builtIn, ...custom]
}

const infoCache = new Map<string, TokenInfo>()

export async function fetchTokenInfo(chainId: number, address: Address): Promise<TokenInfo> {
  if (isAddressEqual(address, NATIVE_TOKEN)) return nativeToken(chainById(chainId)!)
  const known = tokenList(chainId).find((t) => isAddressEqual(t.address, address))
  if (known) return known
  const k = `${chainId}:${address.toLowerCase()}`
  const cached = infoCache.get(k)
  if (cached) return cached
  const client = getClient(chainId)
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => '???'),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
  ])
  const info = { address: getAddress(address), symbol, decimals: Number(decimals) }
  infoCache.set(k, info)
  return info
}

export interface Balance {
  token: TokenInfo
  balance: bigint
}

export async function loadBalances(chainId: number, holder: Address): Promise<Balance[]> {
  const client = getClient(chainId)
  const tokens = tokenList(chainId)
  const balances = await Promise.all(
    tokens.map((t) =>
      isAddressEqual(t.address, NATIVE_TOKEN)
        ? client.getBalance({ address: holder })
        : client.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }).catch(() => 0n),
    ),
  )
  return tokens.map((token, i) => ({ token, balance: balances[i] }))
}
