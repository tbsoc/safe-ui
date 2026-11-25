import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { isAddressEqual, type Address, type Hex } from 'viem'
import { useAccount, useSwitchChain } from 'wagmi'
import type { ChainConfig } from './lib/chains'
import { errorMessage } from './lib/format'
import { batchCalls, type Call } from './lib/multisend'
import { loadQueue, saveQueue, upsertPending, type PendingTx } from './lib/queue'
import { asChainId } from './wagmi'
import { buildSafeTx, computeSafeTxHash, fetchSafeTxHash, type SafeInfo } from './lib/safe'

export type Tab = 'overview' | 'send' | 'allowances' | 'queue' | 'history' | 'settings'

interface SafeContextValue {
  chain: ChainConfig
  info: SafeInfo
  reload: () => Promise<void>
  queue: PendingTx[]
  updateQueue: (fn: (q: PendingTx[]) => PendingTx[]) => void
  propose: (calls: Call[], description: string) => Promise<PendingTx>
  setTab: (t: Tab) => void
  isOwner: (a?: Address) => boolean
  /** Last transaction executed from this browser, shown above the queue. */
  lastExecuted?: { hash: Hex; description: string; nonce: string }
  setLastExecuted: (x: { hash: Hex; description: string; nonce: string } | undefined) => void
}

const SafeContext = createContext<SafeContextValue | null>(null)

export function useSafe() {
  const ctx = useContext(SafeContext)
  if (!ctx) throw new Error('useSafe outside SafeProvider')
  return ctx
}

export function nextNonce(info: SafeInfo, queue: PendingTx[]): bigint {
  let n = info.nonce
  for (const p of queue) {
    const pn = BigInt(p.tx.nonce)
    if (pn >= n) n = pn + 1n
  }
  return n
}

export function SafeProvider(props: {
  chain: ChainConfig
  info: SafeInfo
  reload: () => Promise<void>
  setTab: (t: Tab) => void
  children: ReactNode
}) {
  const { chain, info } = props
  const [queue, setQueue] = useState<PendingTx[]>(() => loadQueue(chain.id, info.address))
  const [lastExecuted, setLastExecuted] = useState<SafeContextValue['lastExecuted']>()

  const updateQueue = useCallback(
    (fn: (q: PendingTx[]) => PendingTx[]) => {
      setQueue((q) => {
        const next = fn(q)
        saveQueue(chain.id, info.address, next)
        return next
      })
    },
    [chain.id, info.address],
  )

  const propose = useCallback(
    async (calls: Call[], description: string) => {
      const batch = batchCalls(calls)
      const nonce = nextNonce(info, loadQueue(chain.id, info.address))
      const tx = buildSafeTx({ ...batch, nonce })
      const safeTxHash = computeSafeTxHash(chain.id, info.address, tx)
      const onchain = await fetchSafeTxHash(chain.id, info.address, tx)
      if (onchain !== safeTxHash) throw new Error(`Hash mismatch: local ${safeTxHash} vs Safe ${onchain}. Not proposing.`)
      const pending: PendingTx = { chainId: chain.id, safe: info.address, safeTxHash, tx, description, createdAt: Date.now(), signatures: {} }
      updateQueue((q) => upsertPending(q, pending))
      props.setTab('queue')
      return pending
    },
    [chain.id, info, updateQueue, props],
  )

  const isOwner = useCallback((a?: Address) => !!a && info.owners.some((o) => isAddressEqual(o, a)), [info.owners])

  return (
    <SafeContext.Provider value={{ chain, info, reload: props.reload, queue, updateQueue, propose, setTab: props.setTab, isOwner, lastExecuted, setLastExecuted }}>
      {props.children}
    </SafeContext.Provider>
  )
}

/** Run a wallet action on the right chain, tracking busy/error/success state for the UI. */
export function useWalletAction(chainId: number) {
  const { address, chainId: walletChainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const run = useCallback(
    async <T,>(fn: (account: Address) => Promise<T>, success?: string): Promise<T | undefined> => {
      setError(undefined)
      setNotice(undefined)
      if (!isConnected || !address) {
        setError('Connect a wallet first.')
        return
      }
      setBusy(true)
      try {
        if (walletChainId !== chainId) await switchChainAsync({ chainId: asChainId(chainId) })
        const out = await fn(address)
        if (success) setNotice(success)
        return out
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [address, chainId, isConnected, switchChainAsync, walletChainId],
  )

  return { run, busy, error, notice, setError, setNotice, account: address }
}
