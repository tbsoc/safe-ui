import { useMemo, useState } from 'react'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { useSignTypedData } from 'wagmi'
import { formatDateTime } from '../lib/format'
import { MAX_NAME, nameTypedData, saveName } from '../lib/names'
import { useNames } from '../names'
import { useSafe, useWalletAction } from '../state'
import { Addr, Card, Status } from './common'

/** Shared address book: everyone sees the names; signers of the co-op Safes can change them. */
export function AddressBook() {
  const { chain, info } = useSafe()
  const { names, available, refetch } = useNames()
  const { signTypedDataAsync } = useSignTypedData()
  const { run, busy, error, notice } = useWalletAction(chain.id)
  const [addr, setAddr] = useState('')
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('')

  const entries = useMemo(
    () =>
      Object.entries(names)
        .map(([a, e]) => ({ address: getAddress(a), ...e }))
        .filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()) || e.address.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [names, filter],
  )
  const unnamedSigners = info.owners.filter((o) => !names[o.toLowerCase()])

  const save = (target: Address, newName: string, done?: string) =>
    run(async (acct) => {
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = (await signTypedDataAsync({ account: acct, ...nameTypedData(target, newName, timestamp) })) as Hex
      await saveName({ address: target, name: newName, timestamp, signer: acct, signature })
      await refetch()
      setAddr('')
      setName('')
    }, done ?? 'Saved.')

  if (available === false)
    return (
      <Card title="Address book">
        <p className="muted small">The shared address book is not set up on this site.</p>
      </Card>
    )

  return (
    <Card title="Address book">
      <p className="muted small">
        Names everyone sees next to addresses in this app. Anyone visiting the site can read them. Signers of the co-op Safes can add, change or remove
        names by signing a free message (no transaction).
      </p>
      <form
        className="form inline"
        onSubmit={(e) => {
          e.preventDefault()
          if (isAddress(addr) && name.trim()) void save(getAddress(addr), name)
        }}
      >
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Address 0x…" spellCheck={false} aria-label="Address to name" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" maxLength={MAX_NAME} aria-label="Name" />
        <button type="submit" className="btn" disabled={busy || !isAddress(addr) || !name.trim()}>
          Save name
        </button>
      </form>
      {unnamedSigners.length > 0 && (
        <p className="small muted">
          Unnamed signers of this Safe:{' '}
          {unnamedSigners.map((o) => (
            <button key={o} type="button" className="link" style={{ marginRight: 8 }} onClick={() => setAddr(o)}>
              {o.slice(0, 6)}…{o.slice(-4)}
            </button>
          ))}
        </p>
      )}
      <Status busy={busy} error={error} notice={notice} />
      {Object.keys(names).length > 8 && (
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search names" aria-label="Search names" style={{ margin: '8px 0' }} />
      )}
      {entries.length === 0 && <p className="muted small">No names yet.</p>}
      <ul className="list">
        {entries.map((e) => (
          <li key={e.address}>
            <Addr address={e.address} chain={chain} />
            <span className="small muted" title={`Set by ${e.by} on ${formatDateTime(e.at)}`}>
              set by {e.by.slice(0, 6)}…{e.by.slice(-4)}
            </span>
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                setAddr(e.address)
                setName(e.name)
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn small ghost danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Remove the name "${e.name}"?`)) void save(e.address, '', 'Name removed.')
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
