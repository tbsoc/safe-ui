import { decodeFunctionData, isAddressEqual, type Address, type Hex } from 'viem'
import { allowanceModuleAbi, erc20Abi, multiSendAbi, safeAbi } from './abis'
import { allowanceModuleByAddress, MULTI_SEND_CALL_ONLY } from './constants'
import { formatAmount } from './format'
import { decodeMultiSendTransactions } from './multisend'
import type { TokenInfo } from './chains'

export interface DecodedCall {
  to: Address
  value: bigint
  operation: number
  /** e.g. "AllowanceModule v1.0.0 · setAllowance" */
  label: string
  functionName?: string
  args?: { name: string; value: string }[]
  raw: Hex
}

const ABIS = [
  { abi: safeAbi, name: 'Safe' },
  { abi: allowanceModuleAbi, name: 'AllowanceModule' },
  { abi: erc20Abi, name: 'ERC-20' },
] as const

function stringify(v: unknown): string {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return `[${v.map(stringify).join(', ')}]`
  return String(v)
}

function decodeOne(safe: Address, to: Address, value: bigint, data: Hex, operation: number, tokens: TokenInfo[]): DecodedCall {
  const base = { to, value, operation, raw: data }
  if (data === '0x' || data.length < 10) return { ...base, label: value > 0n ? 'Native transfer' : 'Empty call' }
  for (const { abi, name } of ABIS) {
    try {
      const decoded = decodeFunctionData({ abi, data })
      const fn = abi.find((item) => item.type === 'function' && item.name === decoded.functionName)
      const inputs = (fn && 'inputs' in fn ? fn.inputs : []) as readonly { name?: string }[]
      const rawArgs = (decoded.args ?? []) as readonly unknown[]
      const args = rawArgs.map((a, i) => ({ name: inputs[i]?.name || `arg${i}`, value: stringify(a) }))
      // Show token amounts in human units next to the raw value, so signers can check them.
      const tokenAddr = name === 'ERC-20' ? to : (rawArgs[inputs.findIndex((x) => x.name === 'token')] as Address | undefined)
      const token = tokenAddr ? tokens.find((t) => isAddressEqual(t.address, tokenAddr)) : undefined
      if (token) {
        args.forEach((arg, i) => {
          if (['amount', 'allowanceAmount'].includes(arg.name) && typeof rawArgs[i] === 'bigint')
            arg.value = `${arg.value} (= ${formatAmount(rawArgs[i] as bigint, token.decimals, token.decimals)} ${token.symbol})`
          if (arg.name === 'token') arg.value = `${arg.value} (${token.symbol})`
        })
      }
      let target: string = name
      if (name === 'Safe' && !isAddressEqual(to, safe)) continue
      if (name === 'AllowanceModule') {
        const dep = allowanceModuleByAddress(to)
        if (!dep) continue
        target = `Allowance Module v${dep.version}`
      }
      if (name === 'Safe') target = 'This Safe'
      return { ...base, label: `${target} · ${decoded.functionName}`, functionName: decoded.functionName, args }
    } catch {
      /* try next ABI */
    }
  }
  return { ...base, label: 'Contract call (unknown)' }
}

/** Break a Safe transaction down into readable calls (unwrapping MultiSend batches). */
export function decodeSafeTx(
  safe: Address,
  tx: { to: Address; value: string; data: Hex; operation: number },
  tokens: TokenInfo[] = [],
): DecodedCall[] {
  if (isAddressEqual(tx.to, MULTI_SEND_CALL_ONLY) && tx.operation === 1) {
    try {
      const { args } = decodeFunctionData({ abi: multiSendAbi, data: tx.data })
      return decodeMultiSendTransactions(args[0]).map((c) => decodeOne(safe, c.to, c.value ?? 0n, c.data, c.operation, tokens))
    } catch {
      /* fall through */
    }
  }
  return [decodeOne(safe, tx.to, BigInt(tx.value), tx.data, tx.operation, tokens)]
}
