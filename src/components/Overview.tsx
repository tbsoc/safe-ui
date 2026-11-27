import { useQuery } from '@tanstack/react-query'
import { allowanceModuleByAddress } from '../lib/constants'
import { formatAmount } from '../lib/format'
import { isSupportedSafeVersion } from '../lib/safe'
import { loadBalances } from '../lib/tokens'
import { useSafe } from '../state'
import { AddressList, Card, Stat } from './common'
import { MyAllowanceNotice } from './MyAllowances'
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
    <div className="overview">
      <MyAllowanceNotice />
      {!isSupportedSafeVersion(info.version) && (
        <p className="status error">This Safe runs contract version {info.version}. This app supports v1.3.0 and newer; signing may not work.</p>
      )}

      <div className="stats">
        <Stat label="Signatures needed" value={`${info.threshold} of ${info.owners.length}`} />
        <Stat label="Network" value={chain.name} hint={`Safe v${info.version}`} />
        <Stat label="Transactions executed" value={info.nonce.toString()} />
        <Stat
          label="Pending"
          value={pending}
          hint={
            <button type="button" className="link" onClick={() => setTab('queue')}>
              open queue
            </button>
          }
        />
      </div>

      <div className="overview-cols">
        <Card title="Signers" actions={<span className="pill">{info.threshold} of {info.owners.length} required</span>}>
          <AddressList chain={chain} numbered rows={info.owners.map((o) => ({ address: o }))} />
          <p className="muted small">Name signers in Settings → Address book.</p>
        </Card>

        <div className="stack">
          <Card
            title="Assets"
            actions={
              <button type="button" className="btn ghost small" onClick={() => balances.refetch()}>
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
            <p className="muted small">Native token and listed tokens with a balance. Add other tokens in Settings.</p>
          </Card>

          <Card title="Modules">
            {info.modules.length === 0 && <p className="muted">No modules enabled.</p>}
            <AddressList
              chain={chain}
              rows={info.modules.map((m) => {
                const am = allowanceModuleByAddress(m)
                return {
                  address: m,
                  label: am ? <strong>Allowance Module v{am.version}</strong> : <span className="tag warn">Unknown module</span>,
                }
              })}
            />
            <p className="muted small">Modules can move funds without the signer threshold. Only keep modules you recognise.</p>
          </Card>
        </div>
      </div>

      <Proposers />
    </div>
  )
}
