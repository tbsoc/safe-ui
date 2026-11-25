import { decodeEventLog, pad, type Address, type Hex, type Log } from 'viem'
import { parseAbi } from 'viem'
import { allowanceModuleAbi } from './abis'
import { chainById } from './chains'
import { getClient } from './rpc'

export interface HistoryEvent {
  source: 'safe' | 'module'
  module?: Address
  eventName: string
  args: Record<string, unknown>
  blockNumber: bigint
  timestamp?: number
  transactionHash: Hex
  logIndex: number
}

interface RawLog {
  address: Address
  topics: Hex[]
  data: Hex
  blockNumber: bigint
  timestamp?: number
  transactionHash: Hex
  logIndex: number
}

/** Blockscout's Etherscan-compatible logs API: full history in one request, no API key. */
async function blockscoutLogs(chainId: number, params: Record<string, string>): Promise<RawLog[]> {
  const chain = chainById(chainId)!
  const qs = new URLSearchParams({ module: 'logs', action: 'getLogs', fromBlock: '0', toBlock: 'latest', ...params })
  const res = await fetch(`${chain.blockscout}/api?${qs}`)
  if (!res.ok) throw new Error(`Blockscout ${res.status}`)
  const body = await res.json()
  if (body.status !== '1') {
    if (typeof body.message === 'string' && body.message.toLowerCase().includes('no logs')) return []
    if (Array.isArray(body.result) && body.result.length === 0) return []
    throw new Error(`Blockscout: ${body.message}`)
  }
  return (body.result as Record<string, string | string[] | null>[]).map((l) => ({
    address: l.address as Address,
    topics: (l.topics as (Hex | null)[]).filter((t): t is Hex => !!t),
    data: l.data as Hex,
    blockNumber: BigInt(l.blockNumber as string),
    timestamp: l.timeStamp ? Number(BigInt(l.timeStamp as string)) : undefined,
    transactionHash: l.transactionHash as Hex,
    logIndex: l.logIndex ? Number(BigInt((l.logIndex as string) || '0x0')) : 0,
  }))
}

/** Fallback: scan recent blocks over RPC in chunks small enough for public endpoints. */
async function rpcLogs(chainId: number, address: Address, topic1: Hex | undefined, blocksBack: bigint): Promise<RawLog[]> {
  const client = getClient(chainId)
  const latest = await client.getBlockNumber()
  const chunk = 9000n
  const out: RawLog[] = []
  const from = latest > blocksBack ? latest - blocksBack : 0n
  for (let end = latest; end >= from; end -= chunk) {
    const start = end - chunk + 1n > from ? end - chunk + 1n : from
    const logs: Log[] = await client.request({
      method: 'eth_getLogs',
      params: [
        {
          address,
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          topics: topic1 ? [null, topic1] : undefined,
        },
      ],
    } as never)
    for (const l of logs) {
      out.push({
        address: l.address,
        topics: l.topics as Hex[],
        data: l.data,
        blockNumber: BigInt(l.blockNumber as unknown as string),
        transactionHash: l.transactionHash!,
        logIndex: Number(l.logIndex),
      })
    }
    if (start === from) break
  }
  return out
}

// Safe events changed which params are indexed between v1.3.0 and v1.4.1, so try both layouts.
const SAFE_EVENTS_INDEXED = parseAbi([
  'event AddedOwner(address indexed owner)',
  'event RemovedOwner(address indexed owner)',
  'event ChangedThreshold(uint256 threshold)',
  'event EnabledModule(address indexed module)',
  'event DisabledModule(address indexed module)',
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 indexed txHash, uint256 payment)',
  'event SafeReceived(address indexed sender, uint256 value)',
  'event ApproveHash(bytes32 indexed approvedHash, address indexed owner)',
  'event ExecutionFromModuleSuccess(address indexed module)',
  'event ExecutionFromModuleFailure(address indexed module)',
  'event ChangedGuard(address indexed guard)',
  'event SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)',
])
const SAFE_EVENTS_PLAIN = parseAbi([
  'event AddedOwner(address owner)',
  'event RemovedOwner(address owner)',
  'event EnabledModule(address module)',
  'event DisabledModule(address module)',
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
  'event ChangedGuard(address guard)',
])

function decodeWith(abis: readonly (readonly unknown[])[], raw: RawLog) {
  for (const abi of abis) {
    try {
      return decodeEventLog({ abi: abi as never, data: raw.data, topics: raw.topics as [Hex, ...Hex[]] }) as {
        eventName: string
        args?: unknown
      }
    } catch {
      /* try next layout */
    }
  }
  throw new Error('unknown event')
}

function decode(raw: RawLog, source: 'safe' | 'module'): HistoryEvent | undefined {
  try {
    const d = decodeWith(source === 'safe' ? [SAFE_EVENTS_INDEXED, SAFE_EVENTS_PLAIN] : [allowanceModuleAbi], raw)
    return {
      source,
      module: source === 'module' ? raw.address : undefined,
      eventName: d.eventName,
      args: (d.args ?? {}) as Record<string, unknown>,
      blockNumber: raw.blockNumber,
      timestamp: raw.timestamp,
      transactionHash: raw.transactionHash,
      logIndex: raw.logIndex,
    }
  } catch {
    return undefined
  }
}

export interface HistoryResult {
  events: HistoryEvent[]
  source: 'blockscout' | 'rpc'
  /** Set when the RPC fallback was used: how far back we looked. */
  blocksScanned?: bigint
}

export async function loadHistory(
  chainId: number,
  safe: Address,
  modules: Address[],
  rpcBlocksBack = 200_000n,
): Promise<HistoryResult> {
  const safeTopic = pad(safe.toLowerCase() as Hex, { size: 32 })
  let raw: { log: RawLog; source: 'safe' | 'module' }[] = []
  let source: HistoryResult['source'] = 'blockscout'
  try {
    const safeLogs = await blockscoutLogs(chainId, { address: safe })
    const moduleLogs = await Promise.all(modules.map((m) => blockscoutLogs(chainId, { address: m, topic1: safeTopic })))
    raw = [...safeLogs.map((log) => ({ log, source: 'safe' as const })), ...moduleLogs.flat().map((log) => ({ log, source: 'module' as const }))]
  } catch {
    source = 'rpc'
    const safeLogs = await rpcLogs(chainId, safe, undefined, rpcBlocksBack)
    const moduleLogs = await Promise.all(modules.map((m) => rpcLogs(chainId, m, safeTopic, rpcBlocksBack)))
    raw = [...safeLogs.map((log) => ({ log, source: 'safe' as const })), ...moduleLogs.flat().map((log) => ({ log, source: 'module' as const }))]
  }
  const events = raw
    .map(({ log, source }) => decode(log, source))
    .filter((e): e is HistoryEvent => !!e)
    .sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1))
  return { events, source, blocksScanned: source === 'rpc' ? rpcBlocksBack : undefined }
}
