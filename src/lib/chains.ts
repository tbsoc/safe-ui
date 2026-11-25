import type { Address, Chain } from 'viem'
import { base, gnosis, mainnet } from 'viem/chains'

export interface TokenInfo {
  address: Address
  symbol: string
  decimals: number
}

export interface ChainConfig {
  id: number
  /** EIP-3770 short name, the same prefix Safe{Wallet} uses in `?safe=base:0x…` */
  shortName: string
  name: string
  chain: Chain
  nativeSymbol: string
  /** Public RPCs, tried in order. Users can override them in Settings. */
  rpcs: string[]
  explorer: string
  /** Blockscout instance, used for full event history (public RPCs cap log ranges). */
  blockscout: string
  /** Tokens shown by default. Every address here was checked on-chain (symbol + decimals). */
  tokens: TokenInfo[]
}

export const NATIVE_TOKEN: Address = '0x0000000000000000000000000000000000000000'

export const CHAINS: ChainConfig[] = [
  {
    id: 1,
    shortName: 'eth',
    name: 'Ethereum',
    chain: mainnet,
    nativeSymbol: 'ETH',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
    explorer: 'https://etherscan.io',
    blockscout: 'https://eth.blockscout.com',
    tokens: [
      { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
      { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 },
      { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    ],
  },
  {
    id: 8453,
    shortName: 'base',
    name: 'Base',
    chain: base,
    nativeSymbol: 'ETH',
    rpcs: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://1rpc.io/base'],
    explorer: 'https://basescan.org',
    blockscout: 'https://base.blockscout.com',
    tokens: [
      { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
      { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
      { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', decimals: 18 },
      { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC', decimals: 6 },
    ],
  },
  {
    id: 100,
    shortName: 'gno',
    name: 'Gnosis',
    chain: gnosis,
    nativeSymbol: 'xDAI',
    rpcs: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'],
    explorer: 'https://gnosisscan.io',
    blockscout: 'https://gnosis.blockscout.com',
    tokens: [
      { address: '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3', symbol: 'BREAD', decimals: 18 },
      { address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', symbol: 'WXDAI', decimals: 18 },
      { address: '0xaf204776c7245bF4147c2612BF6e5972Ee483701', symbol: 'sDAI', decimals: 18 },
      { address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', symbol: 'USDC.e', decimals: 6 },
      { address: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', symbol: 'USDC', decimals: 6 },
      { address: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430', symbol: 'EURe', decimals: 18 },
      { address: '0xcB444e90D8198415266c6a2724b7900fb12FC56E', symbol: 'EURe (v1)', decimals: 18 },
      { address: '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', symbol: 'WETH', decimals: 18 },
    ],
  },
]

export function chainById(id: number): ChainConfig | undefined {
  return CHAINS.find((c) => c.id === id)
}

export function chainByShortName(shortName: string): ChainConfig | undefined {
  return CHAINS.find((c) => c.shortName === shortName.toLowerCase())
}

export function nativeToken(chain: ChainConfig): TokenInfo {
  return { address: NATIVE_TOKEN, symbol: chain.nativeSymbol, decimals: 18 }
}

export function explorerAddress(chain: ChainConfig, address: string) {
  return `${chain.explorer}/address/${address}`
}

export function explorerTx(chain: ChainConfig, hash: string) {
  return `${chain.explorer}/tx/${hash}`
}
