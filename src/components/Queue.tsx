import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { isAddressEqual, type Hex } from 'viem'
import { useSignTypedData, useWriteContract } from 'wagmi'
import { safeAbi } from '../lib/abis'
import { explorerTx, type ChainConfig } from '../lib/chains'
import { decodeSafeTx } from '../lib/decode'
import { errorMessage, formatAmount } from '../lib/format'
import { decodePending, encodePending, extractEncoded, upsertPending, type PendingTx } from '../lib/queue'
import { getClient } from '../lib/rpc'
import { tokenList } from '../lib/tokens'
import {
  computeSafeTxHash,
  execTransactionArgs,
  loadOnchainApprovals,
  normalizeSignature,
  packSignatures,
  planExecution,
  recoverSigner,
  safeTxTypedData,
  type SafeInfo,
} from '../lib/safe'
import { useSafe, useWalletAction } from '../state'
import { Addr, Card, Status } from './common'
import { asChainId } from '../wagmi'

export function shareLink(chain: ChainConfig, p: PendingTx) {
  const url = new URL(window.location.href)
  url.search = `?safe=${chain.shortName}:${p.safe}&tab=queue`
  url.hash = `tx=${encodePending(p)}`
  return url.toString()
}

/** Validate an incoming payload against the current Safe; returns it with only valid owner signatures. */
export async function verifyIncoming(chain: ChainConfig, info: SafeInfo, p: PendingTx): Promise<PendingTx> {
  if (p.chainId !== chain.id || !isAddressEqual(p.safe, info.address)) throw new Error('This link is for a different Safe or network.')
  const hash = computeSafeTxHash(chain.id, info.address, p.tx)
  if (hash !== p.safeTxHash) throw new Error('The transaction hash in this link does not match its contents.')
  const signatures: Record<string, Hex> = {}
  for (const [owner, sig] of Object.entries(p.signatures)) {
    try {
      const signer = await recoverSigner(hash, sig)
      if (isAddressEqual(signer, owner as Hex) && info.owners.some((o) => isAddressEqual(o, signer))) signatures[owner] = normalizeSignature(sig)
    } catch {
      /* drop invalid signature */
    }
  }
  return { ...p, signatures }
}

export function Queue() {
  const { chain, info, queue, updateQueue, lastExecuted, setLastExecuted } = useSafe()
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string>()
  const [importNotice, setImportNotice] = useState<string>()

  const active = queue.filter((p) => BigInt(p.tx.nonce) >= info.nonce).sort((a, b) => Number(BigInt(a.tx.nonce) - BigInt(b.tx.nonce)))
  const stale = queue.filter((p) => BigInt(p.tx.nonce) < info.nonce)

  const doImport = async () => {
    setImportError(undefined)
    setImportNotice(undefined)
    try {
      const p = await verifyIncoming(chain, info, decodePending(extractEncoded(importText)))
      updateQueue((q) => upsertPending(q, p))
      setImportText('')
      setImportNotice(`Imported with ${Object.keys(p.signatures).length} valid signature(s).`)
    } catch (e) {
      setImportError(errorMessage(e))
    }
  }

  return (
    <div className="stack">
      {lastExecuted && (
        <p className="status ok">
          Executed #{lastExecuted.nonce}: {lastExecuted.description}.{' '}
          <a href={explorerTx(chain, lastExecuted.hash)} target="_blank" rel="noreferrer">
            View execution on explorer
          </a>{' '}
          <button type="button" className="link" onClick={() => setLastExecuted(undefined)}>
            dismiss
          </button>
        </p>
      )}
      {active.length === 0 && (
        <Card>
          <p className="muted">No pending transactions in this browser. Create one from Send or Allowances, or import a link a signer shared with you.</p>
        </Card>
      )}
      {active.map((p) => (
        <PendingCard key={p.safeTxHash} p={p} />
      ))}

      <Card title="Import a shared transaction">
        <p className="muted small">
          Paste a link from another signer. Signatures are merged with the ones you already have. Links are encoded, not encrypted: anyone with the link can read the transaction.
        </p>
        <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={3} placeholder="https://…#tx=…" />
        <button type="button" className="btn" onClick={doImport} disabled={!importText.trim()}>
          Import
        </button>
        <Status error={importError} notice={importNotice} />
      </Card>

      {stale.length > 0 && (
        <Card
          title="Already used nonces"
          actions={
            <button type="button" className="btn ghost" onClick={() => updateQueue((q) => q.filter((p) => BigInt(p.tx.nonce) >= info.nonce))}>
              Clear all
            </button>
          }
        >
          <p className="muted small">These were executed, or replaced by another transaction with the same nonce.</p>
          <ul className="list">
            {stale.map((p) => (
              <li key={p.safeTxHash}>
                #{p.tx.nonce} · {p.description}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function PendingCard({ p }: { p: PendingTx }) {
  const { chain, info, updateQueue, reload, isOwner, setLastExecuted } = useSafe()
  const { run, busy, error, notice, account } = useWalletAction(chain.id)
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const approvals = useQuery({
    queryKey: ['approvals', chain.id, info.address, p.safeTxHash, info.nonce.toString()],
    queryFn: () => loadOnchainApprovals(chain.id, info.address, info.owners, p.safeTxHash),
  })

  const hashOk = computeSafeTxHash(chain.id, info.address, p.tx) === p.safeTxHash
  const calls = decodeSafeTx(info.address, p.tx, tokenList(chain.id))
  const isNext = BigInt(p.tx.nonce) === info.nonce
  const plan = planExecution({
    owners: info.owners,
    threshold: info.threshold,
    signatures: p.signatures,
    onchainApprovals: approvals.data ?? [],
    executor: isOwner(account) ? account : undefined,
  })
  const planWithoutExecutor = planExecution({
    owners: info.owners,
    threshold: info.threshold,
    signatures: p.signatures,
    onchainApprovals: approvals.data ?? [],
  })
  const iSigned = !!account && (!!p.signatures[account.toLowerCase()] || (approvals.data ?? []).some((a) => isAddressEqual(a, account)))

  const sign = () =>
    run(async (acct) => {
      const raw = await signTypedDataAsync({ account: acct, ...safeTxTypedData(chain.id, info.address, p.tx) })
      const sig = normalizeSignature(raw)
      const signer = await recoverSigner(p.safeTxHash, sig)
      if (!isAddressEqual(signer, acct))
        throw new Error('The signature does not match your address. Smart-contract wallets must use "Approve on-chain" instead.')
      updateQueue((q) => upsertPending(q, { ...p, signatures: { [acct.toLowerCase()]: sig } }))
    }, 'Signed. Share the updated link with the other signers.')

  const approveOnchain = () =>
    run(async () => {
      const hash = await writeContractAsync({ chainId: asChainId(chain.id), address: info.address, abi: safeAbi, functionName: 'approveHash', args: [p.safeTxHash] })
      await getClient(chain.id).waitForTransactionReceipt({ hash })
      await approvals.refetch()
    }, 'Approved on-chain.')

  const execute = () =>
    run(async (acct) => {
      const args = execTransactionArgs(p.tx, packSignatures(plan.entries))
      // Simulate first so a failing transaction never reaches the wallet.
      await getClient(chain.id).simulateContract({ account: acct, address: info.address, abi: safeAbi, functionName: 'execTransaction', args })
      const hash = await writeContractAsync({ chainId: asChainId(chain.id), address: info.address, abi: safeAbi, functionName: 'execTransaction', args })
      const receipt = await getClient(chain.id).waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
      setLastExecuted({ hash, description: p.description || 'Transaction', nonce: p.tx.nonce })
      await reload()
      return hash
    })

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink(chain, p))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this link', shareLink(chain, p))
    }
  }

  return (
    <Card
      title={
        <>
          <span className="pill">#{p.tx.nonce}</span> {p.description || 'Transaction'}
        </>
      }
      actions={
        <button type="button" className="btn ghost" onClick={copyLink}>
          {copied ? 'Link copied' : 'Copy share link'}
        </button>
      }
    >
      {!hashOk && <p className="status error">Stored hash does not match the transaction. Do not sign this.</p>}
      {!isNext && <p className="status warn">Waiting for nonce #{info.nonce.toString()} to be executed first.</p>}

      <ol className="calls">
        {calls.map((c, i) => (
          <li key={i}>
            <div>
              <strong>{c.label}</strong> {c.operation === 1 && <span className="tag warn">delegatecall</span>}
            </div>
            <div className="small">
              to <Addr address={c.to} chain={chain} />
              {c.value > 0n && (
                <>
                  {' '}
                  · value {formatAmount(c.value, 18, 18)} {chain.nativeSymbol}
                </>
              )}
            </div>
            {c.args && (
              <ul className="args">
                {c.args.map((a) => (
                  <li key={a.name}>
                    <span className="muted">{a.name}:</span> <code>{a.value}</code>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>

      <div className="confirmations">
        <h3>
          Confirmations {planWithoutExecutor.confirmedBy.length}/{info.threshold}
        </h3>
        <ul className="list">
          {info.owners.map((o) => {
            const sig = !!p.signatures[o.toLowerCase()]
            const onchain = (approvals.data ?? []).some((a) => isAddressEqual(a, o))
            return (
              <li key={o}>
                <Addr address={o} chain={chain} />
                {sig ? <span className="tag ok">signed</span> : onchain ? <span className="tag ok">approved on-chain</span> : <span className="tag">waiting</span>}
              </li>
            )
          })}
        </ul>
      </div>

      <details open={showRaw} onToggle={(e) => setShowRaw((e.target as HTMLDetailsElement).open)}>
        <summary>Details for hardware-wallet verification</summary>
        <dl className="dl small">
          <dt>Safe tx hash</dt>
          <dd>
            <code className="break">{p.safeTxHash}</code>
          </dd>
          <dt>To</dt>
          <dd>
            <code className="break">{p.tx.to}</code>
          </dd>
          <dt>Operation</dt>
          <dd>{p.tx.operation === 1 ? 'DELEGATECALL' : 'CALL'}</dd>
          <dt>Data</dt>
          <dd>
            <code className="break">{p.tx.data}</code>
          </dd>
        </dl>
      </details>

      <div className="actions">
        {isOwner(account) && !iSigned && (
          <>
            <button type="button" className="btn primary" onClick={sign} disabled={busy || !hashOk}>
              Sign
            </button>
            <button type="button" className="btn" onClick={approveOnchain} disabled={busy || !hashOk}>
              Approve on-chain
            </button>
          </>
        )}
        <button type="button" className="btn primary" onClick={execute} disabled={busy || !plan.ready || !isNext || !hashOk || !account}>
          Execute
        </button>
        <button
          type="button"
          className="btn ghost danger"
          onClick={() => {
            if (window.confirm('Remove this transaction from this browser? Other signers keep their copies.'))
              updateQueue((q) => q.filter((x) => x.safeTxHash !== p.safeTxHash))
          }}
        >
          Remove
        </button>
      </div>
      {!plan.ready && (
        <p className="muted small">
          Needs {planWithoutExecutor.missing} more confirmation(s)
          {planWithoutExecutor.missing === 1 && ' (or an owner who has not signed can execute it directly)'}.
        </p>
      )}
      {!account && <p className="muted small">Connect a wallet to sign or execute. Anyone can execute once there are enough confirmations.</p>}
      <Status busy={busy} error={error} notice={notice} />
    </Card>
  )
}
