import { createTestClient, createWalletClient, http, type Address, type Chain, type Hex, type PrivateKeyAccount } from 'viem'
import { expect } from 'vitest'
import { safeAbi } from '../src/lib/abis'
import { batchCalls, type Call } from '../src/lib/multisend'
import { getClient } from '../src/lib/rpc'
import {
  buildSafeTx,
  computeSafeTxHash,
  execTransactionArgs,
  fetchSafeTxHash,
  loadOnchainApprovals,
  loadSafeInfo,
  packSignatures,
  planExecution,
  recoverSigner,
  safeTxTypedData,
  type SafeInfo,
} from '../src/lib/safe'

/** Helpers for driving a forked Safe with the same library code the UI uses. */
export function forkHelpers(chain: Chain, rpc: string, safe: Address) {
  const test = createTestClient({ chain, mode: 'hardhat', transport: http(rpc) })
  const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(rpc) })
  const client = () => getClient(chain.id)

  /** Send a transaction from any address (impersonated on the fork). */
  async function sendAs(from: Address, to: Address, data: Hex, value = 0n) {
    // Top up gas money for the impersonated sender (fork only).
    const bal = await client().getBalance({ address: from })
    if (bal < 10n ** 18n) await test.setBalance({ address: from, value: bal + 10n ** 18n })
    await test.impersonateAccount({ address: from })
    const hash = await test.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value: `0x${value.toString(16)}` }] } as never)
    const receipt = await client().waitForTransactionReceipt({ hash: hash as Hex })
    await test.stopImpersonatingAccount({ address: from })
    return receipt
  }

  /** Propose → sign → (optionally approve on-chain) → execute, the way the Queue does it. */
  async function runSafeTx(
    info: SafeInfo,
    calls: Call[],
    signers: PrivateKeyAccount[],
    opts: { onchain?: PrivateKeyAccount; executor: PrivateKeyAccount },
  ) {
    const tx = buildSafeTx({ ...batchCalls(calls), nonce: info.nonce })
    const hash = computeSafeTxHash(chain.id, safe, tx)
    expect(await fetchSafeTxHash(chain.id, safe, tx)).toBe(hash)
    const signatures: Record<string, Hex> = {}
    for (const s of signers) {
      const sig = await s.signTypedData(safeTxTypedData(chain.id, safe, tx))
      expect(await recoverSigner(hash, sig)).toBe(s.address)
      signatures[s.address.toLowerCase()] = sig
    }
    if (opts.onchain) {
      const h = await wallet(opts.onchain).writeContract({ address: safe, abi: safeAbi, functionName: 'approveHash', args: [hash] })
      await client().waitForTransactionReceipt({ hash: h })
    }
    const onchainApprovals = await loadOnchainApprovals(chain.id, safe, info.owners, hash)
    const plan = planExecution({ owners: info.owners, threshold: info.threshold, signatures, onchainApprovals, executor: opts.executor.address })
    expect(plan.ready).toBe(true)
    const args = execTransactionArgs(tx, packSignatures(plan.entries))
    await client().simulateContract({ account: opts.executor.address, address: safe, abi: safeAbi, functionName: 'execTransaction', args })
    const h = await wallet(opts.executor).writeContract({ address: safe, abi: safeAbi, functionName: 'execTransaction', args })
    expect((await client().waitForTransactionReceipt({ hash: h })).status).toBe('success')
    return loadSafeInfo(chain.id, safe)
  }

  return { test, wallet, client, sendAs, runSafeTx }
}

/** Well-known local test keys (Hardhat/Anvil defaults #1–#7). Never use on a live network. */
export const TEST_KEYS: Hex[] = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
]
