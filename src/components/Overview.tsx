import { useQuery } from '@tanstack/react-query'
import { allowanceModuleByAddress } from '../lib/constants'
import { formatAmount } from '../lib/format'
import { isSupportedSafeVersion } from '../lib/safe'
import { loadBalances } from '../lib/tokens'
import { useSafe } from '../state'
import { Addr, Card } from './common'
import { Proposers } from './Proposers'

export function Overview() {
  const { chain, info, queue, setTab } = useSafe()
  const balances = useQuery({
    queryKey: ['balances', chain.id, info.address],
    queryFn: () => loadBalances(chain.id, info.address),
  })
  const nonEmpty = (balances.data ?? []).filter((b, i) => i === 0 || b.balance > 0n)
  const pending = queue.filter((p) => BigInt(p.tx.nonce) >= info.nonce).length

  return (
    <div className="grid">
      {!isSupportedSafeVersion(info.version) && (
        <p className="status error">
          This Safe runs contract version {info.version}. This app supports v1.3.0 and newer; signing may not work.
        </p>
      )}
      <Card
        title="Assets"
        actions={
          <button type="button" className="btn ghost" onClick={() => balances.refetch()}>
            Refresh
          </button>
        }
      >
        {balances.isLoading && <p className="muted">Loading balances…</p>}
        {balances.error && <p className="status error">Could not load balances.</p>}
        <table className="table">
          <tbody>
            {nonEmpty.map((b) => (
              <tr key={b.token.address}>
                <td>{b.token.symbol}</td>
                <td className="num">{formatAmount(b.balance, b.token.decimals)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Shows the native token and tokens from the built-in list with a balance. Add other tokens in Settings.
        </p>
      </Card>

      <Card title="Signers" actions={<span className="pill">{info.threshold} of {info.owners.length} required</span>}>
        <ul className="list">
          {info.owners.map((o) => (
            <li key={o}>
              <Addr address={o} chain={chain} full />
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Status">
        <dl className="dl">
          <dt>Network</dt>
          <dd>{chain.name}</dd>
          <dt>Safe version</dt>
          <dd>{info.version}</dd>
          <dt>Nonce</dt>
          <dd>{info.nonce.toString()}</dd>
          <dt>Pending in this browser</dt>
          <dd>
            {pending}{' '}
            {pending > 0 && (
              <button type="button" className="link" onClick={() => setTab('queue')}>
                open queue
              </button>
            )}
          </dd>
        </dl>
      </Card>

      <Card title="Modules">
        {info.modules.length === 0 && <p className="muted">No modules enabled.</p>}
        <ul className="list">
          {info.modules.map((m) => {
            const am = allowanceModuleByAddress(m)
            return (
              <li key={m}>
                <Addr address={m} chain={chain} full />
                {am ? <span className="tag">Allowance Module v{am.version}</span> : <span className="tag warn">Unknown module</span>}
              </li>
            )
          })}
        </ul>
        <p className="muted small">Modules can move funds without the signer threshold. Only keep modules you recognise.</p>
      </Card>

      <Proposers />
    </div>
  )
}
