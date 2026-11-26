import { useQuery } from '@tanstack/react-query'
import { type Address } from 'viem'
import { allowanceModuleByAddress, allowanceModulesOn } from '../lib/constants'
import { explorerTx } from '../lib/chains'
import { errorMessage, formatAmount, formatDateTime } from '../lib/format'
import { loadHistory, type HistoryEvent } from '../lib/history'
import { fetchTokenInfo } from '../lib/tokens'
import { useSafe } from '../state'
import { Addr, Card } from './common'

const LABELS: Record<string, string> = {
  SafeSetup: 'Safe created',
  ExecutionSuccess: 'Multisig transaction executed',
  ExecutionFailure: 'Multisig transaction failed',
  SafeReceived: 'Received native token',
  AddedOwner: 'Signer added',
  RemovedOwner: 'Signer removed',
  ChangedThreshold: 'Threshold changed',
  EnabledModule: 'Module enabled',
  DisabledModule: 'Module disabled',
  ApproveHash: 'Transaction approved on-chain',
  ExecutionFromModuleSuccess: 'Module transaction',
  ExecutionFromModuleFailure: 'Module transaction failed',
  ChangedGuard: 'Guard changed',
  AddDelegate: 'Allowance member added',
  RemoveDelegate: 'Allowance member removed',
  SetAllowance: 'Allowance set',
  ResetAllowance: 'Allowance spent amount reset',
  DeleteAllowance: 'Allowance deleted',
  ExecuteAllowanceTransfer: 'Allowance spent',
  PayAllowanceTransfer: 'Allowance relayer paid',
}

export function History() {
  const { chain, info } = useSafe()
  // Include every known allowance module, so history survives a module switch.
  const modules = allowanceModulesOn(chain.id).map((m) => m.address as Address)
  const q = useQuery({
    queryKey: ['history', chain.id, info.address, info.nonce.toString()],
    queryFn: async () => {
      const res = await loadHistory(chain.id, info.address, modules)
      const tokenAddrs = new Set<string>()
      res.events.forEach((e) => typeof e.args.token === 'string' && tokenAddrs.add(e.args.token.toLowerCase()))
      const tokens = Object.fromEntries(
        await Promise.all([...tokenAddrs].map(async (t) => [t, await fetchTokenInfo(chain.id, t as Address)] as const)),
      )
      return { ...res, tokens }
    },
  })

  return (
    <Card
      title="History"
      actions={
        <button type="button" className="btn ghost" onClick={() => q.refetch()}>
          Refresh
        </button>
      }
    >
      {q.isLoading && <p className="muted">Loading events…</p>}
      {q.error && <p className="status error">{errorMessage(q.error)}</p>}
      {q.data?.source === 'rpc' && (
        <p className="status warn">
          The block explorer API was unavailable, so this only shows the last {q.data.blocksScanned?.toLocaleString()} blocks, read from the RPC.
        </p>
      )}
      {q.data && q.data.events.length === 0 && <p className="muted">No events found.</p>}
      <ul className="history">
        {q.data?.events.map((e) => (
          <li key={`${e.transactionHash}-${e.logIndex}`}>
            <div>
              <strong>{LABELS[e.eventName] ?? e.eventName}</strong>
              {e.module && <span className="tag">Allowance v{allowanceModuleByAddress(e.module)?.version}</span>}
            </div>
            <EventDetails e={e} tokens={q.data.tokens} />
            <div className="small muted">
              {e.timestamp ? formatDateTime(e.timestamp) : `Block ${e.blockNumber}`} ·{' '}
              <a href={explorerTx(chain, e.transactionHash)} target="_blank" rel="noreferrer">
                tx ↗
              </a>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function EventDetails({ e, tokens }: { e: HistoryEvent; tokens: Record<string, { symbol: string; decimals: number }> }) {
  const { chain } = useSafe()
  const a = e.args as Record<string, unknown>
  const tok = typeof a.token === 'string' ? tokens[a.token.toLowerCase()] : undefined
  const amt = (v: unknown) => (tok && typeof v === 'bigint' ? `${formatAmount(v, tok.decimals)} ${tok.symbol}` : String(v))
  switch (e.eventName) {
    case 'ExecuteAllowanceTransfer':
      return (
        <div className="small">
          <Addr address={String(a.delegate)} chain={chain} /> sent {amt(a.value)} to <Addr address={String(a.to)} chain={chain} />
        </div>
      )
    case 'SetAllowance':
      return (
        <div className="small">
          {amt(a.allowanceAmount)} for <Addr address={String(a.delegate)} chain={chain} />, reset every {String(a.resetTime)} min
        </div>
      )
    case 'AddDelegate':
    case 'RemoveDelegate':
      return (
        <div className="small">
          <Addr address={String(a.delegate)} chain={chain} />
        </div>
      )
    case 'ResetAllowance':
    case 'DeleteAllowance':
      return (
        <div className="small">
          {tok?.symbol} · <Addr address={String(a.delegate)} chain={chain} />
        </div>
      )
    case 'SafeReceived':
      return (
        <div className="small">
          {formatAmount(a.value as bigint, 18)} {chain.nativeSymbol} from <Addr address={String(a.sender)} chain={chain} />
        </div>
      )
    case 'AddedOwner':
    case 'RemovedOwner':
      return (
        <div className="small">
          <Addr address={String(a.owner)} chain={chain} />
        </div>
      )
    case 'EnabledModule':
    case 'DisabledModule':
    case 'ExecutionFromModuleSuccess':
      return (
        <div className="small">
          <Addr address={String(a.module)} chain={chain} />
        </div>
      )
    case 'SafeSetup':
      return (
        <div className="small">
          {(a.owners as string[]).length} signers, threshold {String(a.threshold)}
        </div>
      )
    case 'ChangedThreshold':
      return <div className="small">New threshold: {String(a.threshold)}</div>
    default:
      return null
  }
}
