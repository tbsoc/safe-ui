import { encodeFunctionData, isAddressEqual, type Address } from 'viem'
import { allowanceModuleAbi, safeAbi } from './abis'
import { ALLOWANCE_MODULES, MAX_RESET_MINUTES, MAX_UINT96, STANDARD_ALLOWANCE_MODULE, type AllowanceModuleDeployment } from './constants'
import type { Call } from './multisend'
import { getClient } from './rpc'

export interface Allowance {
  delegate: Address
  token: Address
  amount: bigint
  spent: bigint
  resetTimeMin: number
  lastResetMin: number
  nonce: number
}

export interface ModuleState {
  deployment: AllowanceModuleDeployment
  enabled: boolean
}

/** Which Allowance Module deployments are enabled on this Safe. */
export function detectAllowanceModules(modules: Address[]): ModuleState[] {
  return ALLOWANCE_MODULES.map((deployment) => ({
    deployment,
    enabled: modules.some((m) => isAddressEqual(m, deployment.address)),
  }))
}

/**
 * The module the owners act on: the standard one if enabled, otherwise any enabled legacy one,
 * otherwise the standard one (which then gets enabled in the same transaction).
 */
export function activeModule(modules: Address[]): ModuleState {
  const states = detectAllowanceModules(modules)
  return (
    states.find((s) => s.enabled && s.deployment.standard) ??
    states.find((s) => s.enabled) ?? { deployment: STANDARD_ALLOWANCE_MODULE, enabled: false }
  )
}

export async function loadDelegates(chainId: number, module: Address, safe: Address): Promise<Address[]> {
  const client = getClient(chainId)
  const out: Address[] = []
  let start = 0
  for (let i = 0; i < 50; i++) {
    const [page, next] = await client.readContract({
      address: module,
      abi: allowanceModuleAbi,
      functionName: 'getDelegates',
      args: [safe, start, 50],
    })
    out.push(...page)
    if (next === 0 || page.length === 0) break
    start = next
  }
  return out
}

export async function loadAllowances(chainId: number, module: Address, safe: Address): Promise<{ delegates: Address[]; allowances: Allowance[] }> {
  const client = getClient(chainId)
  const delegates = await loadDelegates(chainId, module, safe)
  const perDelegate = await Promise.all(
    delegates.map(async (delegate) => {
      const tokens = await client.readContract({ address: module, abi: allowanceModuleAbi, functionName: 'getTokens', args: [safe, delegate] })
      return Promise.all(
        tokens.map(async (token) => {
          const [amount, spent, resetTimeMin, lastResetMin, nonce] = await client.readContract({
            address: module,
            abi: allowanceModuleAbi,
            functionName: 'getTokenAllowance',
            args: [safe, delegate, token],
          })
          return {
            delegate,
            token,
            amount,
            spent,
            resetTimeMin: Number(resetTimeMin),
            lastResetMin: Number(lastResetMin),
            nonce: Number(nonce),
          } satisfies Allowance
        }),
      )
    }),
  )
  // getTokens also lists deleted allowances (amount 0, no period); hide those.
  const allowances = perDelegate.flat().filter((a) => !(a.amount === 0n && a.resetTimeMin === 0))
  return { delegates, allowances }
}

export function remaining(a: Allowance): bigint {
  return a.amount > a.spent ? a.amount - a.spent : 0n
}

/** Unix seconds of the next reset, or undefined for one-time allowances. */
export function nextResetAt(a: Allowance, nowSec = Math.floor(Date.now() / 1000)): number | undefined {
  if (a.resetTimeMin === 0) return undefined
  const nowMin = Math.floor(nowSec / 60)
  let next = a.lastResetMin + a.resetTimeMin
  // getTokenAllowance already applies due resets, but stay correct if the view is stale.
  while (next <= nowMin) next += a.resetTimeMin
  return next * 60
}

export function describePeriod(minutes: number): string {
  if (minutes === 0) return 'One-time'
  const day = 60 * 24
  if (minutes % day === 0) {
    const days = minutes / day
    if (days === 1) return 'Daily'
    if (days === 7) return 'Weekly'
    return `Every ${days} days`
  }
  if (minutes % 60 === 0) return `Every ${minutes / 60} h`
  return `Every ${minutes} min`
}

export interface SetAllowanceParams {
  safe: Address
  modules: Address[]
  delegates: Address[]
  delegate: Address
  token: Address
  amount: bigint
  resetTimeMin: number
  /** Unix minutes the reset schedule is anchored to (must be in the past), or 0 to start now. */
  resetBaseMin?: number
  resetSpent?: boolean
  /** Override which module to use (defaults to activeModule). */
  module?: Address
}

/** Calls for "give `delegate` an allowance", enabling the module and adding the delegate if needed. */
export function setAllowanceCalls(p: SetAllowanceParams): Call[] {
  if (p.amount <= 0n) throw new Error('Amount must be greater than zero')
  if (p.amount > MAX_UINT96) throw new Error('Amount is too large for the allowance module (uint96)')
  if (!Number.isInteger(p.resetTimeMin) || p.resetTimeMin < 0 || p.resetTimeMin > MAX_RESET_MINUTES)
    throw new Error(`Reset period must be between 0 and ${MAX_RESET_MINUTES} minutes (about 45 days)`)
  const base = p.resetBaseMin ?? 0
  if (base > 0) {
    if (p.resetTimeMin === 0) throw new Error('A start date only applies to repeating allowances')
    if (base > Math.floor(Date.now() / 60000)) throw new Error('The schedule start must be in the past')
  }
  const module = p.module ?? activeModule(p.modules).deployment.address
  const calls: Call[] = []
  if (!p.modules.some((m) => isAddressEqual(m, module))) {
    calls.push({ to: p.safe, data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [module] }) })
  }
  if (!p.delegates.some((d) => isAddressEqual(d, p.delegate))) {
    calls.push({ to: module, data: encodeFunctionData({ abi: allowanceModuleAbi, functionName: 'addDelegate', args: [p.delegate] }) })
  }
  calls.push({
    to: module,
    data: encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: 'setAllowance',
      args: [p.delegate, p.token, p.amount, p.resetTimeMin, base],
    }),
  })
  if (p.resetSpent) {
    calls.push({ to: module, data: encodeFunctionData({ abi: allowanceModuleAbi, functionName: 'resetAllowance', args: [p.delegate, p.token] }) })
  }
  return calls
}

export function resetAllowanceCall(module: Address, delegate: Address, token: Address): Call {
  return { to: module, data: encodeFunctionData({ abi: allowanceModuleAbi, functionName: 'resetAllowance', args: [delegate, token] }) }
}

export function deleteAllowanceCall(module: Address, delegate: Address, token: Address): Call {
  return { to: module, data: encodeFunctionData({ abi: allowanceModuleAbi, functionName: 'deleteAllowance', args: [delegate, token] }) }
}

export function removeDelegateCall(module: Address, delegate: Address): Call {
  return { to: module, data: encodeFunctionData({ abi: allowanceModuleAbi, functionName: 'removeDelegate', args: [delegate, true] }) }
}

export function disableModuleCall(safe: Address, modules: Address[], module: Address): Call {
  const idx = modules.findIndex((m) => isAddressEqual(m, module))
  if (idx < 0) throw new Error('Module is not enabled')
  // getModulesPaginated returns modules in linked-list order, so the previous entry is the one before it.
  const prev = idx === 0 ? '0x0000000000000000000000000000000000000001' : modules[idx - 1]
  return { to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: 'disableModule', args: [prev, module] }) }
}
