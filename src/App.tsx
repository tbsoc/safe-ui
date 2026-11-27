import { useCallback, useEffect, useState } from 'react'
import { getAddress, isAddress, type Address } from 'viem'
import { Allowances } from './components/Allowances'
import { Addr, Status } from './components/common'
import { ConnectButton } from './components/ConnectButton'
import { History } from './components/History'
import { OtherChains } from './components/OtherChains'
import { Overview } from './components/Overview'
import { Queue, verifyIncoming } from './components/Queue'
import { Send } from './components/Send'
import { Settings } from './components/Settings'
import { CHAINS, chainByShortName, type ChainConfig } from './lib/chains'
import { errorMessage } from './lib/format'
import { decodePending, loadQueue, saveQueue, upsertPending } from './lib/queue'
import { loadSafeInfo, type SafeInfo } from './lib/safe'
import { storage } from './lib/storage'
import { SafeProvider, type Tab } from './state'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'send', label: 'Send' },
  { id: 'allowances', label: 'Allowances' },
  { id: 'queue', label: 'Queue' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
]

/** Safes listed on the start screen. */
const KNOWN_SAFES = [
  { name: 'Bread Coop core team treasury (Gnosis)', ref: 'gno:0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad' },
  { name: 'Bread Cooperative (Base)', ref: 'base:0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A' },
  { name: 'Bread Cooperative (Ethereum)', ref: 'eth:0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A' },
]

interface SafeRef {
  chain: ChainConfig
  address: Address
}

function parseSafeRef(s: string | null): SafeRef | undefined {
  if (!s) return
  const [prefix, addr] = s.trim().split(':')
  const chain = chainByShortName(prefix ?? '')
  if (!chain || !addr || !isAddress(addr)) return
  return { chain, address: getAddress(addr) }
}

function readUrl() {
  const params = new URLSearchParams(window.location.search)
  const tab = (params.get('tab') as Tab) || 'overview'
  return { ref: parseSafeRef(params.get('safe')), tab: TABS.some((t) => t.id === tab) ? tab : 'overview' }
}

function writeUrl(ref: SafeRef | undefined, tab: Tab, keepHash = false) {
  const params = new URLSearchParams()
  if (ref) params.set('safe', `${ref.chain.shortName}:${ref.address}`)
  if (ref && tab !== 'overview') params.set('tab', tab)
  const qs = params.toString()
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${keepHash ? window.location.hash : ''}`
  window.history.replaceState(null, '', url)
}

export default function App() {
  const [{ ref, tab }, setState] = useState(readUrl)
  const [info, setInfo] = useState<SafeInfo>()
  const [loadError, setLoadError] = useState<string>()
  const [importNotice, setImportNotice] = useState<string>()
  const [importError, setImportError] = useState<string>()
  const [queueKey, setQueueKey] = useState(0)

  const setTab = useCallback((t: Tab) => setState((s) => ({ ...s, tab: t })), [])
  const openSafe = (r: SafeRef | undefined) => {
    setInfo(undefined)
    setState({ ref: r, tab: 'overview' })
  }

  useEffect(() => writeUrl(ref, tab, true), [ref, tab])

  const reload = useCallback(async () => {
    if (!ref) return
    setLoadError(undefined)
    try {
      const i = await loadSafeInfo(ref.chain.id, ref.address)
      setInfo(i)
      const recent = storage.get<string[]>('recentSafes', [])
      const key = `${ref.chain.shortName}:${ref.address}`
      storage.set('recentSafes', [key, ...recent.filter((r) => r !== key)].slice(0, 8))
    } catch (e) {
      setLoadError(errorMessage(e))
    }
  }, [ref])

  useEffect(() => {
    reload()
  }, [reload])

  // A shared link carries a pending transaction in the fragment: verify it and add it to the local queue.
  useEffect(() => {
    if (!info || !ref) return
    const m = window.location.hash.match(/tx=([A-Za-z0-9_-]+)/)
    if (!m) return
    ;(async () => {
      try {
        const p = await verifyIncoming(ref.chain, info, decodePending(m[1]))
        saveQueue(ref.chain.id, info.address, upsertPending(loadQueue(ref.chain.id, info.address), p))
        setQueueKey((k) => k + 1)
        setImportNotice(`Loaded shared transaction #${p.tx.nonce} with ${Object.keys(p.signatures).length} valid signature(s).`)
        setTab('queue')
      } catch (e) {
        setImportError(errorMessage(e))
      } finally {
        writeUrl(ref, 'queue')
      }
    })()
  }, [info, ref, setTab])

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" onClick={() => openSafe(undefined)}>
          <span className="logo" aria-hidden>
            🍞
          </span>
          Bread Safe
        </button>
        <ConnectButton wantChainId={ref?.chain.id} />
      </header>

      {!ref && <Landing onOpen={openSafe} />}

      {ref && (
        <main>
          <div className="safe-head">
            <div>
              <span className="pill">{ref.chain.name}</span> <Addr address={ref.address} chain={ref.chain} full />
            </div>
            {info && (
              <div className="muted small">
                v{info.version} · {info.threshold} of {info.owners.length} signers
              </div>
            )}
          </div>
          <OtherChains chainId={ref.chain.id} address={ref.address} onOpen={(chain) => openSafe({ chain, address: ref.address })} />
          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <Status error={importError} notice={importNotice} />
          {loadError && (
            <div className="card">
              <p className="status error">Could not load this Safe: {loadError}</p>
              <button type="button" className="btn" onClick={reload}>
                Retry
              </button>
            </div>
          )}
          {!info && !loadError && <p className="muted">Loading Safe…</p>}
          {info && (
            <SafeProvider key={`${ref.chain.id}:${ref.address}:${queueKey}`} chain={ref.chain} info={info} reload={reload} setTab={setTab}>
              {tab === 'overview' && <Overview />}
              {tab === 'send' && <Send />}
              {tab === 'allowances' && <Allowances />}
              {tab === 'queue' && <Queue />}
              {tab === 'history' && <History />}
              {tab === 'settings' && <Settings />}
            </SafeProvider>
          )}
        </main>
      )}
      <footer className="footer muted small">
        Reads the chain directly. No backend, no tracking.{' '}
        <a href="https://github.com/tbsoc/safe-ui" target="_blank" rel="noreferrer">
          Source
        </a>
      </footer>
    </div>
  )
}

function Landing({ onOpen }: { onOpen: (r: SafeRef) => void }) {
  const [chainShort, setChainShort] = useState('base')
  const [addr, setAddr] = useState('')
  const [error, setError] = useState<string>()
  const recent = storage.get<string[]>('recentSafes', [])
  const list = [...KNOWN_SAFES.map((k) => ({ label: k.name, ref: k.ref })), ...recent.filter((r) => !KNOWN_SAFES.some((k) => k.ref.toLowerCase() === r.toLowerCase())).map((r) => ({ label: r, ref: r }))]

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    // Accept "base:0x…", a full Safe{Wallet} URL, or a bare address with the selected network.
    const text = addr.trim()
    const fromUrl = text.match(/safe=([a-z0-9]+:0x[0-9a-fA-F]{40})/)
    const r = parseSafeRef(fromUrl ? fromUrl[1] : text.includes(':') ? text : `${chainShort}:${text}`)
    if (!r) {
      setError('Enter a Safe address (0x…), "base:0x…", or a Safe{Wallet} link.')
      return
    }
    onOpen(r)
  }

  return (
    <main className="landing">
      <h1>Open a Safe</h1>
      <p className="muted">Works with Safe multisigs (v1.3.0+) on Ethereum, Base, Gnosis, Optimism and Celo.</p>
      <form className="form" onSubmit={submit}>
        <div className="form inline">
          <select value={chainShort} onChange={(e) => setChainShort(e.target.value)} aria-label="Network">
            {CHAINS.map((c) => (
              <option key={c.id} value={c.shortName}>
                {c.name}
              </option>
            ))}
          </select>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x… or base:0x… or app.safe.global link" spellCheck={false} aria-label="Safe address" />
          <button type="submit" className="btn primary">
            Open
          </button>
        </div>
        <Status error={error} />
      </form>
      {list.length > 0 && (
        <ul className="safe-list">
          {list.map((s) => {
            const r = parseSafeRef(s.ref)
            if (!r) return null
            return (
              <li key={s.ref}>
                <button type="button" className="safe-link" onClick={() => onOpen(r)}>
                  <strong>{s.label}</strong>
                  <span className="muted small">
                    {r.chain.name} · {r.address}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
