/**
 * End-to-end test against a local fork of Gnosis Chain (FORK_CHAIN=gno npm run fork), using the
 * real Bread Coop core team Safe. That Safe (v1.4.1, 5 of 10) already has BOTH legacy Allowance
 * Modules enabled (v0.1.0 and v0.1.1) with live allowances, so this checks the app handles
 * several modules at once and never adds a third one.
 *
 * The fork impersonates the Safe once to add five test keys as extra owners (threshold stays 5).
 */
import { encodeFunctionData, isAddressEqual, parseEther, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { gnosis } from 'viem/chains'
import { beforeAll, describe, expect, it } from 'vitest'
import { allowanceModuleAbi, erc20Abi, safeAbi } from '../src/lib/abis'
import { activeModule, loadAllAllowances, remaining, resetAllowanceCall, setAllowanceCalls } from '../src/lib/allowances'
import { STANDARD_ALLOWANCE_MODULE, ZERO_ADDRESS } from '../src/lib/constants'
import { loadSafeInfo, type SafeInfo } from '../src/lib/safe'
import { forkHelpers, TEST_KEYS } from './helpers'

const RPC = process.env.VITE_RPC_URL_100 ?? 'http://127.0.0.1:8545'
const SAFE: Address = '0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad'
const BREAD: Address = '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3'
const V010: Address = '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134'
const V011: Address = '0xAA46724893dedD72658219405185Fb0Fc91e091C'
const RECIPIENT: Address = '0x000000000000000000000000000000000000bEEF'

const [o1, o2, o3, member, relayer, o4, o5] = TEST_KEYS.map((k) => privateKeyToAccount(k))
const owners = [o1, o2, o3, o4, o5]
const { test, wallet, client, sendAs, runSafeTx } = forkHelpers(gnosis, RPC, SAFE)
const breadOf = (a: Address) => client().readContract({ address: BREAD, abi: erc20Abi, functionName: 'balanceOf', args: [a] })

let info: SafeInfo

describe.runIf(process.env.FORK_CHAIN === 'gno')('Bread core team Safe on a Gnosis fork', () => {
  beforeAll(async () => {
    for (const a of [...owners, member, relayer]) await test.setBalance({ address: a.address, value: parseEther('10') })
    const before = await loadSafeInfo(100, SAFE)
    for (const o of owners) {
      await sendAs(SAFE, SAFE, encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [o.address, BigInt(before.threshold)] }))
    }
    info = await loadSafeInfo(100, SAFE)
  }, 180_000)

  it('reads the Safe and both enabled legacy modules', async () => {
    expect(info.version).toBe('1.4.1')
    expect(info.threshold).toBe(5)
    expect(info.modules).toEqual(expect.arrayContaining([V010, V011]))
    expect(info.modules).not.toContain(STANDARD_ALLOWANCE_MODULE.address)
    expect(activeModule(info.modules).deployment.version).toBe('0.1.1')
    const per = await loadAllAllowances(100, SAFE, info.modules)
    expect(per.map((m) => m.deployment.version).sort()).toEqual(['0.1.0', '0.1.1'])
    // Both modules have live BREAD allowances; every allowance is tagged with its module.
    for (const m of per) {
      expect(m.allowances.length).toBeGreaterThan(0)
      expect(m.allowances.every((a) => isAddressEqual(a.module, m.deployment.address))).toBe(true)
      expect(m.allowances.some((a) => isAddressEqual(a.token, BREAD))).toBe(true)
    }
  })

  it('lets an existing v0.1.1 member spend through the module their allowance lives on', async () => {
    const per = await loadAllAllowances(100, SAFE, info.modules)
    const a = per.find((m) => m.deployment.version === '0.1.1')!.allowances.find((x) => remaining(x) > 0n)
    if (!a) return // nothing left to spend this period on the live chain
    const amount = remaining(a) < parseEther('10') ? remaining(a) : parseEther('10')
    const before = await breadOf(RECIPIENT)
    await test.setBalance({ address: a.delegate, value: parseEther('1') })
    const data = encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: 'executeAllowanceTransfer',
      args: [SAFE, BREAD, RECIPIENT, amount, ZERO_ADDRESS, 0n, a.delegate, '0x'],
    })
    expect((await sendAs(a.delegate, a.module, data)).status).toBe('success')
    expect((await breadOf(RECIPIENT)) - before).toBe(amount)
  }, 60_000)

  it('adds a new member on the existing v0.1.1 module without enabling another module', async () => {
    const per = await loadAllAllowances(100, SAFE, info.modules)
    const target = activeModule(info.modules).deployment.address
    const calls = setAllowanceCalls({
      safe: SAFE,
      modules: info.modules,
      delegates: per.find((m) => isAddressEqual(m.deployment.address, target))!.delegates,
      delegate: member.address,
      token: BREAD,
      amount: parseEther('50'),
      resetTimeMin: 60 * 24 * 30,
    })
    expect(calls).toHaveLength(2) // addDelegate + setAllowance, no enableModule
    expect(calls.every((c) => isAddressEqual(c.to, V011))).toBe(true)
    info = await runSafeTx(info, calls, owners, { executor: relayer })
    expect(info.modules).not.toContain(STANDARD_ALLOWANCE_MODULE.address)

    const before = await breadOf(RECIPIENT)
    const h = await wallet(member).writeContract({
      address: V011,
      abi: allowanceModuleAbi,
      functionName: 'executeAllowanceTransfer',
      args: [SAFE, BREAD, RECIPIENT, parseEther('25'), ZERO_ADDRESS, 0n, member.address, '0x'],
    })
    expect((await client().waitForTransactionReceipt({ hash: h })).status).toBe('success')
    expect((await breadOf(RECIPIENT)) - before).toBe(parseEther('25'))
  }, 90_000)

  it('blocks the member on the other module (allowances are per module)', async () => {
    await expect(
      client().simulateContract({
        account: member.address,
        address: V010,
        abi: allowanceModuleAbi,
        functionName: 'executeAllowanceTransfer',
        args: [SAFE, BREAD, RECIPIENT, 1n, ZERO_ADDRESS, 0n, member.address, '0x'],
      }),
    ).rejects.toThrow()
  })

  it('resets a v0.1.0 allowance on v0.1.0, with 3 signatures + 1 on-chain approval + an executing owner', async () => {
    const per = await loadAllAllowances(100, SAFE, info.modules)
    const a = per.find((m) => m.deployment.version === '0.1.0')!.allowances.find((x) => x.spent > 0n)
    if (!a) return
    info = await runSafeTx(info, [resetAllowanceCall(a.module, a.delegate, a.token)], [o1, o2, o3], { onchain: o4, executor: o5 })
    const after = await loadAllAllowances(100, SAFE, info.modules)
    const updated = after.find((m) => m.deployment.version === '0.1.0')!.allowances.find((x) => isAddressEqual(x.delegate, a.delegate))!
    expect(updated.spent).toBe(0n)
  }, 90_000)
})
