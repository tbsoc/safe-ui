import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from 'viem'
import { useAccount, useSignTypedData } from 'wagmi'
import { errorMessage } from '../lib/format'
import { addProposer, delegateTypedData, isProposerFor, listProposers, removeProposer, type Proposer } from '../lib/proposers'
import { QueueUnavailableError } from '../lib/safeQueue'
import { useSafe, useWalletAction } from '../state'
import { Addr, Card, Field, Status } from './common'
import { AddressInput } from './AddressInput'

/** Is the connected wallet a proposer for the current Safe and chain? (false when the shared queue is off) */
export function useIsProposer(account?: Address) {
  const { chain, info, isOwner } = useSafe()
  const q = useQuery({
    queryKey: ['isProposer', chain.id, info.address, account],
    queryFn: () => isProposerFor(chain.id, info.address, info.owners, account!).catch(() => false),
    enabled: !!account && !isOwner(account),
    staleTime: 60_000,
  })
  return !!account && !isOwner(account) && q.data === true
}

export function Proposers() {
  const { chain, info, isOwner } = useSafe()
  const { address: account } = useAccount()
  const qc = useQueryClient()
  const { signTypedDataAsync } = useSignTypedData()
  const { run, busy, error, notice } = useWalletAction(chain.id)
  const [addr, setAddr] = useState('')
  const [label, setLabel] = useState('')

  const list = useQuery({
    queryKey: ['proposers', chain.id, info.address, info.owners.join(',')],
    queryFn: async () => {
      try {
        return { available: true as const, items: await listProposers(chain.id, info.address, info.owners) }
      } catch (e) {
        if (e instanceof QueueUnavailableError) return { available: false as const, items: [] as Proposer[] }
        throw e
      }
    },
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['proposers', chain.id, info.address] })
    qc.invalidateQueries({ queryKey: ['isProposer', chain.id, info.address] })
  }

  const sign = (acct: Address, delegate: Address, action: 'add' | 'delete') =>
    // Cast: the domain has a non-standard `safe` field, declared explicitly in types.EIP712Domain.
    signTypedDataAsync({ account: acct, ...(delegateTypedData({ delegate, chainId: chain.id, safe: info.address, action }) as object) } as never) as Promise<Hex>

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    run(async (acct) => {
      if (!isAddress(addr)) throw new Error('Enter a valid address')
      const delegate = getAddress(addr)
      if (isOwner(delegate)) throw new Error('That address is already a signer of this Safe')
      const signature = await sign(acct, delegate, 'add')
      await addProposer({ delegate, delegator: acct, safe: info.address, chainId: chain.id, label: label.trim(), signature })
      setAddr('')
      setLabel('')
      refresh()
    }, 'Proposer added.')
  }

  const remove = (p: Proposer) =>
    run(async (acct) => {
      const signature = await sign(acct, p.delegate, 'delete')
      await removeProposer({ delegate: p.delegate, delegator: p.delegator, safe: p.safe, chainId: p.chainId, signature })
      refresh()
    }, 'Proposer removed.')

  if (list.data && list.data.available === false)
    return (
      <Card title="Proposers">
        <p className="muted small">Proposers need the shared queue, which is not configured on this site.</p>
      </Card>
    )

  return (
    <Card title="Proposers">
      <p className="muted small">
        Proposers can put transactions in this Safe&apos;s queue on {chain.name} but cannot sign them; signers still have to reach {info.threshold} of{' '}
        {info.owners.length}. Stored in Safe&apos;s queue, so Safe{'{Wallet}'} shows them too. Adding or removing one is a free signature, not a
        transaction.
      </p>
      {list.isLoading && <p className="muted small">Loading…</p>}
      {list.error && <p className="status error">{errorMessage(list.error)}</p>}
      {list.data?.items.length === 0 && <p className="muted small">No proposers.</p>}
      <ul className="list">
        {list.data?.items.map((p) => {
          const canRemove = !!account && (isAddressEqual(account, p.delegator) || isAddressEqual(account, p.delegate))
          return (
            <li key={`${p.delegate}-${p.delegator}`}>
              {p.label && <strong>{p.label}</strong>}
              <Addr address={p.delegate} chain={chain} />
              <span className="small muted">
                added by <Addr address={p.delegator} chain={chain} />
              </span>
              {canRemove && (
                <button type="button" className="btn small danger" onClick={() => remove(p)} disabled={busy}>
                  Remove
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {isOwner(account) ? (
        <form className="form" onSubmit={add} style={{ marginTop: 12 }}>
          <div className="form inline">
            <AddressInput value={addr} onChange={setAddr} placeholder="Proposer: name or 0x…" ariaLabel="Proposer address" />
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (optional)" maxLength={50} aria-label="Proposer name" />
            <button type="submit" className="btn" disabled={busy || !isAddress(addr)}>
              Add proposer
            </button>
          </div>
          <Field label="" hint="You sign a message authorizing this address for this Safe on this network only.">
            <span />
          </Field>
        </form>
      ) : (
        <p className="muted small">Connect a signer wallet to add proposers. A proposer can remove themselves.</p>
      )}
      <Status busy={busy} error={error} notice={notice} />
    </Card>
  )
}
