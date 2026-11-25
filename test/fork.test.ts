/**
 * End-to-end test against a local fork of Base (see scripts/fork-test.mjs), using the real
 * Bread Cooperative Safe and the real Allowance Module v1.0.0 deployment.
 *
 * The fork impersonates the Safe once to add three test keys as extra owners (threshold stays 3),
 * then drives every flow through the same library code the UI uses.
 */
import { createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { beforeAll, describe, expect, it } from 'vitest'
import { allowanceModuleAbi, erc20Abi, safeAbi } from '../src/lib/abis'
import { activeModule, loadAllowances, resetAllowanceCall, setAllowanceCalls } from '../src/lib/allowances'
import { STANDARD_ALLOWANCE_MODULE, ZERO_ADDRESS } from '../src/lib/constants'
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

const RPC = process.env.VITE_RPC_URL_8453!
const SAFE: Address = '0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A'
const WETH: Address = '0x4200000000000000000000000000000000000006'
const MODULE = STANDARD_ALLOWANCE_MODULE.address

const ownerA = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const ownerB = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const ownerC = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6')
const member = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a')
const relayer = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba')
const recipient: Address = '0x000000000000000000000000000000000000bEEF'

const test = createTestClient({ chain: base, mode: 'hardhat', transport: http(RPC) })
const wallet = (account = relayer) => createWalletClient({ account, chain: base, transport: http(RPC) })
const client = () => getClient(8453)

async function asSafe(data: Hex, to: Address = SAFE, value = 0n) {
  await test.impersonateAccount({ address: SAFE })
  const hash = await test.request({ method: 'eth_sendTransaction', params: [{ from: SAFE, to, data, value: `0x${value.toString(16)}` }] } as never)
  await client().waitForTransactionReceipt({ hash: hash as Hex })
  await test.stopImpersonatingAccount({ address: SAFE })
}

/** Propose → sign → execute, the way the Queue does it. */
async function runSafeTx(info: SafeInfo, calls: Call[], signers: typeof ownerA[], opts: { onchain?: typeof ownerA; executor?: typeof ownerA } = {}) {
  const tx = buildSafeTx({ ...batchCalls(calls), nonce: info.nonce })
  const hash = computeSafeTxHash(8453, SAFE, tx)
  expect(await fetchSafeTxHash(8453, SAFE, tx)).toBe(hash)
  const signatures: Record<string, Hex> = {}
  for (const s of signers) {
    const sig = await s.signTypedData(safeTxTypedData(8453, SAFE, tx))
    expect(await recoverSigner(hash, sig)).toBe(s.address)
    signatures[s.address.toLowerCase()] = sig
  }
  if (opts.onchain) {
    const h = await wallet(opts.onchain).writeContract({ address: SAFE, abi: safeAbi, functionName: 'approveHash', args: [hash] })
    await client().waitForTransactionReceipt({ hash: h })
  }
  const executor = opts.executor ?? relayer
  const onchainApprovals = await loadOnchainApprovals(8453, SAFE, info.owners, hash)
  const plan = planExecution({ owners: info.owners, threshold: info.threshold, signatures, onchainApprovals, executor: executor.address })
  expect(plan.ready).toBe(true)
  const args = execTransactionArgs(tx, packSignatures(plan.entries))
  await client().simulateContract({ account: executor.address, address: SAFE, abi: safeAbi, functionName: 'execTransaction', args })
  const h = await wallet(executor).writeContract({ address: SAFE, abi: safeAbi, functionName: 'execTransaction', args })
  const receipt = await client().waitForTransactionReceipt({ hash: h })
  expect(receipt.status).toBe('success')
  return loadSafeInfo(8453, SAFE)
}

let info: SafeInfo

beforeAll(async () => {
  for (const a of [ownerA, ownerB, ownerC, member, relayer]) await test.setBalance({ address: a.address, value: parseEther('10') })
  await test.setBalance({ address: SAFE, value: parseEther('5') })
  for (const o of [ownerA, ownerB, ownerC]) {
    await asSafe(encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [o.address, 3n] }))
  }
  // Give the Safe 2 WETH to test ERC-20 allowances.
  await asSafe(encodeFunctionData({ abi: parseAbi(['function deposit() payable']), functionName: 'deposit' }), WETH, parseEther('2'))
  info = await loadSafeInfo(8453, SAFE)
}, 120_000)

describe('Bread Safe on a Base fork', () => {
  it('reads the Safe', () => {
    expect(info.version).toBe('1.5.0')
    expect(info.threshold).toBe(3)
    expect(info.owners).toContain(ownerA.address)
    expect(activeModule(info.modules).enabled).toBe(false)
  })

  it('enables v1.0.0, adds a member and sets a WETH allowance in one multisig transaction', async () => {
    const calls = setAllowanceCalls({
      safe: SAFE,
      modules: info.modules,
      delegates: [],
      delegate: member.address,
      token: WETH,
      amount: parseEther('1'),
      resetTimeMin: 60 * 24 * 30,
    })
    expect(calls).toHaveLength(3)
    info = await runSafeTx(info, calls, [ownerA, ownerB, ownerC])
    expect(info.modules).toContain(MODULE)
    const { delegates, allowances } = await loadAllowances(8453, MODULE, SAFE)
    expect(delegates).toEqual([member.address])
    expect(allowances).toHaveLength(1)
    expect(allowances[0].amount).toBe(parseEther('1'))
    expect(allowances[0].resetTimeMin).toBe(43200)
  }, 60_000)

  it('lets the member spend within the allowance on their own (msg.sender auth)', async () => {
    const before = await client().readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })
    const args = [SAFE, WETH, recipient, parseEther('0.4'), ZERO_ADDRESS, 0n, member.address, '0x'] as const
    const h = await wallet(member).writeContract({ address: MODULE, abi: allowanceModuleAbi, functionName: 'executeAllowanceTransfer', args })
    expect((await client().waitForTransactionReceipt({ hash: h })).status).toBe('success')
    const after = await client().readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] })
    expect(after - before).toBe(parseEther('0.4'))
    const { allowances } = await loadAllowances(8453, MODULE, SAFE)
    expect(allowances[0].spent).toBe(parseEther('0.4'))
  }, 60_000)

  it('blocks spending over the allowance', async () => {
    const args = [SAFE, WETH, recipient, parseEther('0.7'), ZERO_ADDRESS, 0n, member.address, '0x'] as const
    await expect(
      client().simulateContract({ account: member.address, address: MODULE, abi: allowanceModuleAbi, functionName: 'executeAllowanceTransfer', args }),
    ).rejects.toThrow()
  })

  it('blocks non-members', async () => {
    const args = [SAFE, WETH, recipient, 1n, ZERO_ADDRESS, 0n, relayer.address, '0x'] as const
    await expect(
      client().simulateContract({ account: relayer.address, address: MODULE, abi: allowanceModuleAbi, functionName: 'executeAllowanceTransfer', args }),
    ).rejects.toThrow()
  })

  it('accepts a member signature relayed by someone else', async () => {
    const { allowances } = await loadAllowances(8453, MODULE, SAFE)
    const nonce = allowances[0].nonce
    const sig = await member.signTypedData({
      domain: { chainId: 8453, verifyingContract: MODULE },
      types: {
        AllowanceTransfer: [
          { name: 'safe', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint96' },
          { name: 'paymentToken', type: 'address' },
          { name: 'payment', type: 'uint96' },
          { name: 'nonce', type: 'uint16' },
        ],
      },
      primaryType: 'AllowanceTransfer',
      message: { safe: SAFE, token: WETH, to: recipient, amount: parseEther('0.1'), paymentToken: ZERO_ADDRESS, payment: 0n, nonce },
    })
    const args = [SAFE, WETH, recipient, parseEther('0.1'), ZERO_ADDRESS, 0n, member.address, sig] as const
    const h = await wallet(relayer).writeContract({ address: MODULE, abi: allowanceModuleAbi, functionName: 'executeAllowanceTransfer', args })
    expect((await client().waitForTransactionReceipt({ hash: h })).status).toBe('success')
  }, 60_000)

  it('resets the spent amount using an on-chain approval + an executing owner + one signature', async () => {
    info = await runSafeTx(info, [resetAllowanceCall(MODULE, member.address, WETH)], [ownerA], { onchain: ownerB, executor: ownerC })
    const { allowances } = await loadAllowances(8453, MODULE, SAFE)
    expect(allowances[0].spent).toBe(0n)
  }, 60_000)

  it('updates the amount without touching the module or delegate list', async () => {
    const { delegates } = await loadAllowances(8453, MODULE, SAFE)
    const calls = setAllowanceCalls({
      safe: SAFE,
      modules: info.modules,
      delegates,
      delegate: member.address,
      token: WETH,
      amount: parseEther('0.25'),
      resetTimeMin: 10080,
    })
    expect(calls).toHaveLength(1)
    info = await runSafeTx(info, calls, [ownerA, ownerB, ownerC])
    const { allowances } = await loadAllowances(8453, MODULE, SAFE)
    expect(allowances[0].amount).toBe(parseEther('0.25'))
    expect(allowances[0].resetTimeMin).toBe(10080)
  }, 60_000)
})
