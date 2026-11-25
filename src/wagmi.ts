import { createConfig, fallback, http } from 'wagmi'
import { base, gnosis, mainnet } from 'wagmi/chains'
import { injected, walletConnect } from 'wagmi/connectors'
import { chainById } from './lib/chains'
import { rpcUrls } from './lib/rpc'

const wcProjectId = import.meta.env.VITE_WC_PROJECT_ID as string | undefined

const transport = (id: number) => fallback(rpcUrls(chainById(id)!).map((u) => http(u)))

export const wagmiConfig = createConfig({
  chains: [base, gnosis, mainnet],
  connectors: [
    injected(),
    ...(wcProjectId
      ? [
          walletConnect({
            projectId: wcProjectId,
            metadata: {
              name: 'Bread Safe',
              description: 'Safe multisig interface for Bread Cooperative',
              url: typeof window !== 'undefined' ? window.location.origin : 'https://localhost',
              icons: [],
            },
          }),
        ]
      : []),
  ],
  transports: {
    [base.id]: transport(base.id),
    [gnosis.id]: transport(gnosis.id),
    [mainnet.id]: transport(mainnet.id),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}

export type SupportedChainId = (typeof wagmiConfig)['chains'][number]['id']
export const asChainId = (id: number) => id as SupportedChainId
