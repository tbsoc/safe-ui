import { Fragment, useEffect, useMemo, useState } from 'react'
import { getAddress, isAddress, isAddressEqual, toFunctionSelector, type Address } from 'viem'
import { useAccount, useWriteContract } from 'wagmi'
import { allowanceModuleAbi, erc20Abi } from '../lib/abis'
import {
  activeModule,
  deleteAllowanceCall,
  describePeriod,
  detectAllowanceModules,
  nextResetAt,
  remaining,
  removeDelegateCall,
  resetAllowanceCall,
  setAllowanceCalls,
  type Allowance,
} from '../lib/allowances'
import { explorerTx, NATIVE_TOKEN, type TokenInfo } from '../lib/chains'
import { allowanceModuleByAddress, MAX_RESET_MINUTES, RESET_PRESETS, ZERO_ADDRESS, type AllowanceModuleDeployment } from '../lib/constants'
import { errorMessage, formatAmount, formatDateTime, parseAmount, relativeTime } from '../lib/format'
import { getClient } from '../lib/rpc'
import { fetchTokenInfo, tokenList } from '../lib/tokens'
import { useSafe, useWalletAction } from '../state'
import { asChainId } from '../wagmi'
import { Addr, Card, Field, MyAddressButton, Status, TokenSelect } from './common'
import { useIsProposer } from './Proposers'
import { useAllowanceData } from './MyAllowances'

export function Allowances() {
  const { chain, info, isOwner } = useSafe()
  const { address: account } = useAccount()
  const states = detectAllowanceModules(info.modules)
  const enabled = states.filter((s) => s.enabled)
  const active = activeModule(info.modules)

  const data = useAllowanceData()

  const [editing, setEditing] = useState<Allowance>()
  const [formModule, setFormModule] = useState<Address>(active.deployment.address)
  const mine = (data.data?.allowances ?? []).filter((a) => account && isAddressEqual(a.delegate, account) && a.amount > 0n)
  const proposer = useIsProposer(account)
  // Signers and proposers can create allowance transactions; only signers can sign them.
  const owner = isOwner(account) || proposer
  const formTarget = editing?.module ?? formModule
  const formDelegates = data.data?.perModule.find((m) => isAddressEqual(m.deployment.address, formTarget))?.delegates ?? []
  const hasLegacy = enabled.some((s) => !s.deployment.standard)

  return (
    <div className="stack">
      <Card title="Allowance module">
        <p>
          Allowances let a member spend up to a set amount of a token from the Safe, on their own, without collecting signatures. The limit can
          reset on a schedule (for example every 30 days). Owners set and change allowances with a normal multisig transaction.
        </p>
        <dl className="dl">
          {enabled.length === 0 && (
            <>
              <dt>Module</dt>
              <dd>
                v{active.deployment.version} <Addr address={active.deployment.address} chain={chain} /> <span className="tag warn">not enabled yet</span>
              </dd>
            </>
          )}
          {enabled.map((s) => {
            const m = data.data?.perModule.find((x) => isAddressEqual(x.deployment.address, s.deployment.address))
            return (
              <Fragment key={s.deployment.address}>
                <dt>Enabled</dt>
                <dd>
                  v{s.deployment.version} <Addr address={s.deployment.address} chain={chain} />{' '}
                  {m && <span className="tag">{m.allowances.filter((a) => a.amount > 0n).length} active allowance(s)</span>}
                  {isAddressEqual(s.deployment.address, active.deployment.address) && enabled.length > 1 && <span className="tag ok">default for new</span>}
                </dd>
              </Fragment>
            )
          })}
        </dl>
        {enabled.length === 0 && (
          <p className="muted small">
            The first allowance you create also enables the module, in the same transaction. Enabling a module lets it move funds according to its
            own rules (here: only within the allowances owners set).
          </p>
        )}
        {enabled.length > 1 && (
          <p className="muted small">
            This Safe has more than one Allowance Module enabled. Each keeps its own members and allowances; all of them are listed below and every
            change goes to the module the allowance lives on.
          </p>
        )}
        {hasLegacy && (
          <p className="muted small">
            Legacy versions keep working. The newer v1.0.0 fixes a nonce overflow (only reachable after 65,535 transfers by one member) and the
            handling of tokens that return false instead of reverting.
          </p>
        )}
      </Card>

      {mine.length > 0 && (
        <Card title="Spend your allowance">
          {mine.map((a) => (
            <SpendForm key={`${a.module}-${a.token}`} allowance={a} token={data.data!.tokens[a.token.toLowerCase()]} onDone={() => data.refetch()} />
          ))}
        </Card>
      )}

      <Card
        title="Allowances"
        actions={
          <button type="button" className="btn ghost" onClick={() => data.refetch()}>
            Refresh
          </button>
        }
      >
        {data.isLoading && <p className="muted">Loading…</p>}
        {data.error && <p className="status error">{errorMessage(data.error)}</p>}
        {data.data && data.data.allowances.length === 0 && <p className="muted">No allowances set.</p>}
        {data.data && data.data.allowances.length > 0 && (
          <AllowanceTable
            allowances={data.data.allowances}
            tokens={data.data.tokens}
            showModule={enabled.length > 1}
            canManage={owner}
            onEdit={(a) => {
              setEditing(a)
              document.getElementById('allowance-form')?.scrollIntoView({ behavior: 'smooth' })
            }}
          />
        )}
        {data.data?.perModule.map((m) =>
          m.delegates.length > 0 ? (
            <Members
              key={m.deployment.address}
              title={enabled.length > 1 ? `Members on v${m.deployment.version}` : 'Members (delegates)'}
              delegates={m.delegates}
              allowances={m.allowances}
              module={m.deployment.address}
              canManage={owner}
            />
          ) : null,
        )}
      </Card>

      <AllowanceForm
        key={editing ? `${editing.module}-${editing.delegate}-${editing.token}` : `new-${formModule}`}
        editing={editing}
        module={formTarget}
        moduleChoices={enabled.length > 1 && !editing ? enabled.map((s) => s.deployment) : []}
        onModuleChange={setFormModule}
        delegates={formDelegates}
        onCancel={() => setEditing(undefined)}
        canManage={owner}
      />
    </div>
  )
}

function AllowanceTable(props: {
  allowances: Allowance[]
  tokens: Record<string, TokenInfo>
  showModule: boolean
  canManage: boolean
  onEdit: (a: Allowance) => void
}) {
  const { chain, propose } = useSafe()
  const [error, setError] = useState<string>()

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Member</th>
              {props.showModule && <th>Module</th>}
              <th>Token</th>
              <th className="num">Allowance</th>
              <th className="num">Spent</th>
              <th className="num">Left</th>
              <th>Resets</th>
              {props.canManage && <th />}
            </tr>
          </thead>
          <tbody>
            {props.allowances.map((a) => {
              const t = props.tokens[a.token.toLowerCase()] ?? { symbol: '?', decimals: 18, address: a.token }
              const next = nextResetAt(a)
              return (
                <tr key={`${a.module}-${a.delegate}-${a.token}`}>
                  <td>
                    <Addr address={a.delegate} chain={chain} />
                  </td>
                  {props.showModule && <td>v{allowanceModuleByAddress(a.module)?.version}</td>}
                  <td>{t.symbol}</td>
                  <td className="num">{formatAmount(a.amount, t.decimals)}</td>
                  <td className="num">{formatAmount(a.spent, t.decimals)}</td>
                  <td className="num">{formatAmount(remaining(a), t.decimals)}</td>
                  <td>
                    {describePeriod(a.resetTimeMin)}
                    {next && (
                      <div className="small muted" title={formatDateTime(next)}>
                        next {relativeTime(next)}
                      </div>
                    )}
                  </td>
                  {props.canManage && (
                    <td>
                      <div className="row-actions">
                      <button type="button" className="btn small" onClick={() => props.onEdit(a)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled={a.spent === 0n}
                        onClick={() =>
                          act(() => propose([resetAllowanceCall(a.module, a.delegate, a.token)], `Reset spent ${t.symbol} allowance of ${a.delegate}`))
                        }
                      >
                        Reset spent
                      </button>
                      <button
                        type="button"
                        className="btn small danger"
                        onClick={() =>
                          act(() => propose([deleteAllowanceCall(a.module, a.delegate, a.token)], `Delete ${t.symbol} allowance of ${a.delegate}`))
                        }
                      >
                        Delete
                      </button>
                      </div>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {props.canManage && (
        <p className="muted small">Edit, reset and delete create Safe transactions in the Queue; they take effect once executed.</p>
      )}
      <Status error={error} />
    </>
  )
}

function Members(props: { title: string; delegates: Address[]; allowances: Allowance[]; module: Address; canManage: boolean }) {
  const { chain, propose } = useSafe()
  const [error, setError] = useState<string>()
  const count = (d: Address) => props.allowances.filter((a) => isAddressEqual(a.delegate, d)).length
  const active = props.delegates.filter((d) => count(d) > 0)
  const inactive = props.delegates.filter((d) => count(d) === 0)

  const row = (d: Address) => (
    <li key={d}>
      <Addr address={d} chain={chain} full />
      <span className="tag">{count(d)} allowance(s)</span>
      {props.canManage && (
        <button
          type="button"
          className="btn small danger"
          onClick={async () => {
            setError(undefined)
            try {
              await propose([removeDelegateCall(props.module, d)], `Remove member ${d} and all their allowances`)
            } catch (e) {
              setError(errorMessage(e))
            }
          }}
        >
          Remove member
        </button>
      )}
    </li>
  )

  return (
    <div className="sub">
      <h3>{props.title}</h3>
      {active.length > 0 && <ul className="list">{active.map(row)}</ul>}
      {inactive.length > 0 && (
        <details>
          <summary>
            {inactive.length} member(s) with no active allowance (still registered as delegates)
          </summary>
          <ul className="list">{inactive.map(row)}</ul>
        </details>
      )}
      <Status error={error} />
    </div>
  )
}

function toLocalInput(unixMin: number) {
  const d = new Date(unixMin * 60000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function AllowanceForm(props: {
  editing?: Allowance
  module: Address
  moduleChoices: AllowanceModuleDeployment[]
  onModuleChange: (m: Address) => void
  delegates: Address[]
  onCancel: () => void
  canManage: boolean
}) {
  const { chain, info, propose } = useSafe()
  const tokens = tokenList(chain.id)
  const e = props.editing
  const [delegate, setDelegate] = useState<string>(e?.delegate ?? '')
  const [token, setToken] = useState<TokenInfo>(() => tokens.find((t) => e && isAddressEqual(t.address, e.token)) ?? tokens[0])
  const [customToken, setCustomToken] = useState('')
  const [amount, setAmount] = useState('')
  const presetMatch = RESET_PRESETS.find((p) => p.minutes === (e?.resetTimeMin ?? 43200))
  const [preset, setPreset] = useState<string>(presetMatch ? String(presetMatch.minutes) : 'custom')
  const [customMinutes, setCustomMinutes] = useState(String(e?.resetTimeMin ?? 43200))
  const [anchor, setAnchor] = useState('')
  const [resetSpent, setResetSpent] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  // Resolve a custom token address typed by the user.
  const [resolved, setResolved] = useState<TokenInfo>()
  useEffect(() => {
    setResolved(undefined)
    if (!isAddress(customToken)) return
    let cancelled = false
    fetchTokenInfo(chain.id, getAddress(customToken))
      .then((t) => !cancelled && setResolved(t))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [chain.id, customToken])

  // When editing an allowance on a token outside the list, resolve it.
  useEffect(() => {
    if (e && !tokens.some((t) => isAddressEqual(t.address, e.token))) setCustomToken(e.token)
    if (e) {
      fetchTokenInfo(chain.id, e.token).then((t) => setAmount(formatAmountPlain(e.amount, t.decimals)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const effectiveToken = resolved ?? token
  const minutes = preset === 'custom' ? Number(customMinutes) : Number(preset)
  const parsed = parseAmount(amount, effectiveToken.decimals)
  const anchorMin = anchor ? Math.floor(new Date(anchor).getTime() / 60000) : 0

  const preview = useMemo(() => {
    if (!isAddress(delegate) || parsed === undefined) return undefined
    try {
      return setAllowanceCalls({
        safe: info.address,
        modules: info.modules,
        delegates: props.delegates,
        delegate: getAddress(delegate),
        token: effectiveToken.address,
        amount: parsed,
        resetTimeMin: minutes,
        resetBaseMin: anchorMin,
        resetSpent,
        module: props.module,
      })
    } catch {
      return undefined
    }
  }, [delegate, parsed, minutes, anchorMin, resetSpent, effectiveToken.address, info, props.delegates, props.module])

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      if (!isAddress(delegate)) throw new Error('Enter a valid member address')
      if (parsed === undefined) throw new Error('Enter a valid amount')
      const calls = setAllowanceCalls({
        safe: info.address,
        modules: info.modules,
        delegates: props.delegates,
        delegate: getAddress(delegate),
        token: effectiveToken.address,
        amount: parsed,
        resetTimeMin: minutes,
        resetBaseMin: anchorMin,
        resetSpent,
        module: props.module,
      })
      await propose(calls, `${e ? 'Update' : 'Set'} allowance: ${amount} ${effectiveToken.symbol} ${describePeriod(minutes).toLowerCase()} for ${getAddress(delegate)}`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!props.canManage)
    return (
      <Card title="Set an allowance">
        <p className="muted">Connect a signer or proposer wallet of this Safe to create or change allowances.</p>
      </Card>
    )

  return (
    <Card title={e ? 'Edit allowance' : 'Set an allowance'}>
      <form id="allowance-form" className="form" onSubmit={submit}>
        {props.moduleChoices.length > 0 && (
          <Field label="Module" htmlFor="al-module" hint="This Safe has several Allowance Modules enabled. Pick the one this allowance should live on.">
            <select id="al-module" value={props.module} onChange={(x) => props.onModuleChange(x.target.value as Address)}>
              {props.moduleChoices.map((m) => (
                <option key={m.address} value={m.address}>
                  v{m.version} ({m.address.slice(0, 6)}…{m.address.slice(-4)})
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Member address (delegate)" htmlFor="al-delegate" hint="An externally owned wallet, or a Safe that will call the module itself.">
          <input
            id="al-delegate"
            value={delegate}
            onChange={(x) => setDelegate(x.target.value)}
            placeholder="0x…"
            spellCheck={false}
            disabled={!!e}
          />
        </Field>
        <Field label="Token" htmlFor="al-token">
          <TokenSelect
            id="al-token"
            tokens={tokens}
            value={token.address}
            onChange={(t) => {
              setToken(t)
              setCustomToken('')
            }}
          />
        </Field>
        <Field label="…or another token address" htmlFor="al-custom" hint={resolved ? `${resolved.symbol} (${resolved.decimals} decimals)` : undefined}>
          <input id="al-custom" value={customToken} onChange={(x) => setCustomToken(x.target.value)} placeholder="0x… (optional)" spellCheck={false} disabled={!!e} />
        </Field>
        <Field label={`Amount per period (${effectiveToken.symbol})`} htmlFor="al-amount">
          <input id="al-amount" value={amount} onChange={(x) => setAmount(x.target.value)} placeholder="0.0" inputMode="decimal" />
        </Field>
        <Field label="Resets" htmlFor="al-period">
          <select id="al-period" value={preset} onChange={(x) => setPreset(x.target.value)}>
            {RESET_PRESETS.map((p) => (
              <option key={p.minutes} value={String(p.minutes)}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom (minutes)</option>
          </select>
        </Field>
        {preset === 'custom' && (
          <Field label="Reset period in minutes" htmlFor="al-minutes" hint={`1 to ${MAX_RESET_MINUTES} (about 45 days). 0 means one-time.`}>
            <input id="al-minutes" value={customMinutes} onChange={(x) => setCustomMinutes(x.target.value)} inputMode="numeric" />
          </Field>
        )}
        {minutes > 0 && (
          <Field
            label="Align schedule to (optional)"
            htmlFor="al-anchor"
            hint={
              anchor
                ? 'Resets happen at this time plus whole periods. Must be in the past.'
                : e
                  ? `Leave empty to keep the current schedule (last reset ${formatDateTime(e.lastResetMin * 60)}).`
                  : 'Leave empty to start the first period when the transaction executes.'
            }
          >
            <input id="al-anchor" type="datetime-local" value={anchor} onChange={(x) => setAnchor(x.target.value)} max={toLocalInput(Math.floor(Date.now() / 60000))} />
          </Field>
        )}
        {e && e.spent > 0n && (
          <label className="check">
            <input type="checkbox" checked={resetSpent} onChange={(x) => setResetSpent(x.target.checked)} /> Also reset the amount already spent this period
          </label>
        )}
        {preview && (
          <div className="preview small">
            <strong>This creates one Safe transaction that will:</strong>
            <ol>
              {preview.map((c, i) => (
                <li key={i}>{describeCall(c.data)}</li>
              ))}
            </ol>
          </div>
        )}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={busy || !preview}>
            {e ? 'Create update transaction' : 'Create transaction'}
          </button>
          {e && (
            <button type="button" className="btn ghost" onClick={props.onCancel}>
              Cancel
            </button>
          )}
        </div>
        <Status error={error} busy={busy} />
      </form>
    </Card>
  )
}

const CALL_DESCRIPTIONS: Record<string, string> = {
  [toFunctionSelector('enableModule(address)')]: 'Enable the Allowance Module on this Safe',
  [toFunctionSelector('addDelegate(address)')]: 'Add the member as a delegate',
  [toFunctionSelector('setAllowance(address,address,uint96,uint16,uint32)')]: 'Set the allowance amount and reset period',
  [toFunctionSelector('resetAllowance(address,address)')]: 'Reset the amount spent this period',
}

function describeCall(data: string) {
  const sel = data.slice(0, 10)
  return CALL_DESCRIPTIONS[sel] ?? `Call ${sel}`
}

function formatAmountPlain(v: bigint, decimals: number) {
  const s = v.toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${int}.${frac}` : int
}

export function SpendForm(props: { allowance: Allowance; token?: TokenInfo; onDone: () => void }) {
  const { chain, info } = useSafe()
  const a = props.allowance
  const t = props.token ?? { symbol: '?', decimals: 18, address: a.token }
  const { run, busy, error, notice } = useWalletAction(chain.id)
  const { writeContractAsync } = useWriteContract()
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [txHash, setTxHash] = useState<string>()
  const left = remaining(a)
  const parsed = parseAmount(amount, t.decimals)
  const tooMuch = parsed !== undefined && parsed > left
  const valid = isAddress(to) && parsed !== undefined && parsed > 0n && !tooMuch
  const next = nextResetAt(a)

  const spend = () =>
    run(async (acct) => {
      const client = getClient(chain.id)
      const bal = isAddressEqual(t.address, NATIVE_TOKEN)
        ? await client.getBalance({ address: info.address })
        : await client.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [info.address] })
      if (bal < parsed!) throw new Error(`The Safe only holds ${formatAmount(bal, t.decimals)} ${t.symbol}.`)
      // Empty signature = the module authenticates the delegate as msg.sender.
      const args = [info.address, t.address, getAddress(to), parsed!, ZERO_ADDRESS, 0n, acct, '0x'] as const
      await client.simulateContract({ account: acct, address: a.module, abi: allowanceModuleAbi, functionName: 'executeAllowanceTransfer', args })
      const hash = await writeContractAsync({ chainId: asChainId(chain.id), address: a.module, abi: allowanceModuleAbi, functionName: 'executeAllowanceTransfer', args })
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Transaction reverted')
      setTxHash(hash)
      setAmount('')
      props.onDone()
    }, 'Sent.')

  return (
    <div className="spend">
      <p>
        <strong>
          {formatAmount(left, t.decimals)} {t.symbol}
        </strong>{' '}
        left of {formatAmount(a.amount, t.decimals)} · {describePeriod(a.resetTimeMin)}
        {next && <> · resets {relativeTime(next)}</>}
      </p>
      <div className="form inline">
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient 0x…" spellCheck={false} aria-label="Recipient" />
        <MyAddressButton onPick={setTo} />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Amount ${t.symbol}`} inputMode="decimal" aria-label="Amount" />
        <button type="button" className="btn small" onClick={() => setAmount(formatAmountPlain(left, t.decimals))}>
          Max
        </button>
        <button type="button" className="btn primary" disabled={!valid || busy} onClick={spend}>
          Send
        </button>
      </div>
      {tooMuch && <p className="status error">That is more than your remaining allowance.</p>}
      <Status busy={busy} error={error} notice={notice} />
      {txHash && (
        <p className="small">
          <a href={explorerTx(chain, txHash)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      )}
    </div>
  )
}
