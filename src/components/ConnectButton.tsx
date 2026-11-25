import { useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { chainById } from '../lib/chains'
import { shortAddress } from '../lib/format'
import { asChainId } from '../wagmi'

export function ConnectButton({ wantChainId }: { wantChainId?: number }) {
  const { address, chainId, isConnected, connector } = useAccount()
  const { connectors, connect, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const [open, setOpen] = useState(false)

  if (isConnected && address) {
    const wrongChain = wantChainId !== undefined && chainId !== wantChainId
    return (
      <div className="connect">
        {wrongChain && (
          <button type="button" className="btn warn" onClick={() => switchChain({ chainId: asChainId(wantChainId) })}>
            Switch to {chainById(wantChainId)?.name}
          </button>
        )}
        <span className="pill" title={`${address} via ${connector?.name}`}>
          {chainById(chainId ?? 0)?.name ?? `Chain ${chainId}`} · {shortAddress(address)}
        </span>
        <button type="button" className="btn ghost" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    )
  }

  // De-duplicate injected connectors (EIP-6963 discovery + generic "Injected").
  const unique = connectors.filter((c, i, all) => all.findIndex((x) => x.name === c.name) === i)

  return (
    <div className="connect">
      <button type="button" className="btn primary" onClick={() => setOpen((o) => !o)} disabled={isPending}>
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
      {open && (
        <div className="menu">
          {unique.map((c) => (
            <button
              type="button"
              key={c.uid}
              className="menu-item"
              onClick={() => {
                connect({ connector: c })
                setOpen(false)
              }}
            >
              {c.name}
            </button>
          ))}
          {error && <p className="status error">{error.message}</p>}
        </div>
      )}
    </div>
  )
}
