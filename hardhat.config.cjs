// Only used by the fork tests (npm run test:fork). Not part of the app build.
module.exports = {
  networks: {
    hardhat: {
      chainId: 8453,
      hardfork: 'cancun',
      chains: { 8453: { hardforkHistory: { cancun: 0 } } },
      forking: { url: process.env.FORK_URL || 'https://base-rpc.publicnode.com' },
    },
  },
}
