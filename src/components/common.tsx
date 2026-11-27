import { useState, type ReactNode } from 'react'
import { isAddressEqual, type Address } from 'viem'
import { explorerAddress, type ChainConfig, type TokenInfo } from '../lib/chains'
import { shortAddress } from '../lib/format'
import { useAddressName } from '../names'

export function Addr({ address, chain, label, full }: { address: string; chain?: ChainConfig; label?: string; full?: boolean }) {
  const [copied, setCopied] = useState(false)
  const known = useAddressName(address)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <span className="addr" title={address}>
      {label && <span className="addr-label">{label}</span>}
      {known && !label && <span className="addr-name">{known}</span>}
      <code>{full ? address : shortAddress(address)}</code>
      <button type="button" className="icon-btn" onClick={copy} aria-label="Copy address">
        {copied ? '✓' : '⧉'}
      </button>
      {chain && (
        <a className="icon-btn" href={explorerAddress(chain, address)} target="_blank" rel="noreferrer" aria-label="Open in explorer">
          ↗
        </a>
      )}
    </span>
  )
}

export function Status({ error, notice, busy }: { error?: string; notice?: ReactNode; busy?: boolean }) {
  if (busy) return <p className="status busy">Waiting for wallet / network…</p>
  if (error) return <p className="status error">{error}</p>
  if (notice) return <p className="status ok">{notice}</p>
  return null
}

export function TokenSelect({
  tokens,
  value,
  onChange,
  id,
}: {
  tokens: TokenInfo[]
  value?: Address
  onChange: (t: TokenInfo) => void
  id?: string
}) {
  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={(e) => {
        const t = tokens.find((x) => x.address === e.target.value)
        if (t) onChange(t)
      }}
    >
      {tokens.map((t) => (
        <option key={t.address} value={t.address}>
          {t.symbol}
        </option>
      ))}
    </select>
  )
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <small className="hint">{hint}</small>}
    </div>
  )
}

export function sameAddr(a?: string, b?: string) {
  return !!a && !!b && isAddressEqual(a as Address, b as Address)
}
