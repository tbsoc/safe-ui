import { useState } from 'react'
import { useAccount } from 'wagmi'
import { encodeFunctionData, getAddress, isAddress } from 'viem'
import { erc20Abi } from '../lib/abis'
import { NATIVE_TOKEN, type TokenInfo } from '../lib/chains'
import { errorMessage, parseAmount } from '../lib/format'
import { tokenList } from '../lib/tokens'
import { useSafe } from '../state'
import { Card, Field, MyAddressButton, Status, TokenSelect } from './common'
import { useIsProposer } from './Proposers'
import { MyAllowanceSpend, useMyAllowances } from './MyAllowances'

export function Send() {
  const { chain, propose, isOwner } = useSafe()
  const { address: account } = useAccount()
  const proposer = useIsProposer(account)
  const canCreate = isOwner(account) || proposer
  const { mine } = useMyAllowances()
  const [mode, setMode] = useState<'allowance' | 'multisig'>()
  // Members default to their allowance; signers/proposers without one get the multisig form.
  const effectiveMode = mode ?? (mine.length > 0 ? 'allowance' : 'multisig')
  const tokens = tokenList(chain.id)
  const [token, setToken] = useState<TokenInfo>(tokens[0])
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const parsed = parseAmount(amount, token.decimals)
  const valid = isAddress(to) && parsed !== undefined && parsed > 0n

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError(undefined)
    setBusy(true)
    try {
      const recipient = getAddress(to)
      const call =
        token.address === NATIVE_TOKEN
          ? { to: recipient, value: parsed!, data: '0x' as const }
          : {
              to: token.address,
              data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, parsed!] }),
            }
      await propose([call], note || `Send ${amount} ${token.symbol} to ${recipient}`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const chooser =
    mine.length > 0 && canCreate ? (
      <div className="segmented" role="radiogroup" aria-label="How to send">
        <button type="button" role="radio" aria-checked={effectiveMode === 'allowance'} className={effectiveMode === 'allowance' ? 'seg active' : 'seg'} onClick={() => setMode('allowance')}>
          From my allowance
          <small>no signatures needed</small>
        </button>
        <button type="button" role="radio" aria-checked={effectiveMode === 'multisig'} className={effectiveMode === 'multisig' ? 'seg active' : 'seg'} onClick={() => setMode('multisig')}>
          Multisig transaction
          <small>needs the signer threshold</small>
        </button>
      </div>
    ) : null

  if (mine.length > 0 && effectiveMode === 'allowance')
    return (
      <Card title="Send funds">
        {chooser}
        <p className="muted">Send from your allowance. It goes out right away from your own wallet (you pay the network fee), within the amount left.</p>
        <MyAllowanceSpend />
      </Card>
    )

  if (!canCreate)
    return (
      <Card title="Send funds">
        <p className="muted">Connect a signer or proposer wallet of this Safe to create a transaction, or a member wallet to spend an allowance.</p>
      </Card>
    )

  return (
    <Card title="Send funds">
      {chooser}
      <p className="muted">
        Creates a Safe transaction that needs the signer threshold. It goes to the Queue, where signers sign and anyone executes it.
      </p>
      <form onSubmit={submit} className="form">
        <Field label="Token" htmlFor="send-token">
          <TokenSelect id="send-token" tokens={tokens} value={token.address} onChange={setToken} />
        </Field>
        <Field label="Recipient" htmlFor="send-to">
          <div className="form inline">
            <input id="send-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} />
            <MyAddressButton onPick={setTo} />
          </div>
        </Field>
        <Field label={`Amount (${token.symbol})`} htmlFor="send-amount">
          <input id="send-amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" inputMode="decimal" />
        </Field>
        <Field label="Note for signers (optional)" htmlFor="send-note">
          <input id="send-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        <button type="submit" className="btn primary" disabled={!valid || busy}>
          Create transaction
        </button>
        <Status error={error} busy={busy} />
      </form>
    </Card>
  )
}
