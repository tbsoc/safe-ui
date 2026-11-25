import { concat, encodeFunctionData, encodePacked, size, type Address, type Hex } from 'viem'
import { multiSendAbi } from './abis'
import { MULTI_SEND_CALL_ONLY } from './constants'

export interface Call {
  to: Address
  value?: bigint
  data: Hex
}

/** Encode calls in the MultiSend packed format: operation(1) to(20) value(32) dataLength(32) data. */
export function encodeMultiSendTransactions(calls: Call[]): Hex {
  return concat(
    calls.map((c) =>
      encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, c.to, c.value ?? 0n, BigInt(size(c.data)), c.data]),
    ),
  )
}

/**
 * Turn a list of calls into a single Safe transaction target.
 * One call goes out directly; several are batched via MultiSendCallOnly (DELEGATECALL),
 * which keeps msg.sender = the Safe for every inner call (needed for enableModule, addDelegate…).
 */
export function batchCalls(calls: Call[]): { to: Address; value: bigint; data: Hex; operation: 0 | 1 } {
  if (calls.length === 0) throw new Error('Nothing to do')
  if (calls.length === 1) return { to: calls[0].to, value: calls[0].value ?? 0n, data: calls[0].data, operation: 0 }
  return {
    to: MULTI_SEND_CALL_ONLY,
    value: 0n,
    data: encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [encodeMultiSendTransactions(calls)] }),
    operation: 1,
  }
}

export function decodeMultiSendTransactions(packed: Hex): (Call & { operation: number })[] {
  const hex = packed.slice(2)
  const out: (Call & { operation: number })[] = []
  let i = 0
  while (i < hex.length) {
    const operation = parseInt(hex.slice(i, i + 2), 16)
    i += 2
    const to = ('0x' + hex.slice(i, i + 40)) as Address
    i += 40
    const value = BigInt('0x' + hex.slice(i, i + 64))
    i += 64
    const len = Number(BigInt('0x' + hex.slice(i, i + 64)))
    i += 64
    const data = ('0x' + hex.slice(i, i + len * 2)) as Hex
    i += len * 2
    out.push({ operation, to, value, data })
  }
  return out
}
