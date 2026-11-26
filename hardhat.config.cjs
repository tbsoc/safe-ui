// Only used by the fork tests (FORK_CHAIN=base|gno|eth|oeth|celo npm run fork). Not part of the app build.
const FORKS = {
  base: { chainId: 8453, url: 'https://base-rpc.publicnode.com' },
  gno: { chainId: 100, url: 'https://rpc.gnosischain.com' },
  eth: { chainId: 1, url: 'https://ethereum-rpc.publicnode.com' },
  oeth: { chainId: 10, url: 'https://mainnet.optimism.io' },
  celo: { chainId: 42220, url: 'https://forno.celo.org' },
}
const fork = FORKS[process.env.FORK_CHAIN || 'base']
module.exports = {
  networks: {
    hardhat: {
      chainId: fork.chainId,
      hardfork: 'cancun',
      chains: { [fork.chainId]: { hardforkHistory: { cancun: 0 } } },
      forking: { url: process.env.FORK_URL || fork.url },
    },
  },
}
