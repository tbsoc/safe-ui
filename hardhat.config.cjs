// Only used by the fork tests (npm run fork / FORK_CHAIN=gno npm run fork). Not part of the app build.
const FORKS = {
  base: { chainId: 8453, url: 'https://base-rpc.publicnode.com' },
  gno: { chainId: 100, url: 'https://rpc.gnosischain.com' },
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
