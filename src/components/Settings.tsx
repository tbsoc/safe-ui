import { useState } from 'react'
import { getAddress, isAddress } from 'viem'
import { CHAINS } from '../lib/chains'
import { errorMessage } from '../lib/format'
import { getRpcOverrides, setRpcOverride } from '../lib/rpc'
import { addCustomToken, fetchTokenInfo, getCustomTokens, removeCustomToken } from '../lib/tokens'
import { useSafe } from '../state'
import { Addr, Card, Field, Status } from './common'
import { AddressBook } from './AddressBook'

export function Settings() {
  const { chain } = useSafe()
  const [overrides, setOverrides] = useState(getRpcOverrides())
  const [drafts, setDrafts] = useState<Record<number, string>>(() => ({ ...getRpcOverrides() }))
  const [custom, setCustom] = useState(getCustomTokens(chain.id))
  const [tokenAddr, setTokenAddr] = useState('')
  const [error, setError] = useState<string>()

  const saveRpc = (id: number) => {
    const v = (drafts[id] ?? '').trim()
    if (v && !/^https?:\/\//.test(v)) {
      setError('RPC URL must start with http:// or https://')
      return
    }
    setRpcOverride(id, v || undefined)
    setOverrides(getRpcOverrides())
    setError(undefined)
    // wagmi transports are built at startup; reload so every client uses the new RPC.
    window.location.reload()
  }

  const addToken = async () => {
    setError(undefined)
    try {
      if (!isAddress(tokenAddr)) throw new Error('Not a valid address')
      const info = await fetchTokenInfo(chain.id, getAddress(tokenAddr))
      if (info.symbol === '???') throw new Error('That address does not look like an ERC-20 token on this network')
      addCustomToken(chain.id, info)
      setCustom(getCustomTokens(chain.id))
      setTokenAddr('')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="stack">
      <AddressBook />

      <Card title={`Tokens on ${chain.name}`}>
        <p className="muted small">Added tokens appear in balances, Send and Allowances. Stored in this browser only.</p>
        <ul className="list">
          {custom.map((t) => (
            <li key={t.address}>
              {t.symbol} <Addr address={t.address} chain={chain} />
              <button
                type="button"
                className="btn small ghost"
                onClick={() => {
                  removeCustomToken(chain.id, t.address)
                  setCustom(getCustomTokens(chain.id))
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="form inline">
          <input value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)} placeholder="Token address 0x…" spellCheck={false} aria-label="Token address" />
          <button type="button" className="btn" onClick={addToken}>
            Add token
          </button>
        </div>
      </Card>

      <Card title="RPC endpoints">
        <p className="muted small">
          By default the app uses free public RPCs and falls back between them. If they are slow or rate-limited, paste your own endpoint. Stored in this
          browser only.
        </p>
        {CHAINS.map((c) => (
          <Field key={c.id} label={c.name} htmlFor={`rpc-${c.id}`} hint={overrides[c.id] ? 'Custom RPC in use' : `Default: ${c.rpcs.join(', ')}`}>
            <div className="form inline">
              <input
                id={`rpc-${c.id}`}
                value={drafts[c.id] ?? ''}
                onChange={(e) => setDrafts({ ...drafts, [c.id]: e.target.value })}
                placeholder="https://…"
                spellCheck={false}
              />
              <button type="button" className="btn" onClick={() => saveRpc(c.id)}>
                Save
              </button>
            </div>
          </Field>
        ))}
      </Card>
      <Status error={error} />

      <Card title="About">
        <p className="small">
          Open-source Safe interface for Bread Cooperative. It reads the Safe contracts directly through public RPCs. Pending transactions and
          signatures are shared through Safe&apos;s Queue Service (visible in Safe{'{Wallet}'} too), via this site&apos;s server so the API key stays private.
          Share links work as a backup. No accounts, no tracking.
        </p>
      </Card>
    </div>
  )
}
