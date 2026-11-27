import { useQuery } from '@tanstack/react-query'
import { isAddressEqual, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { loadAllAllowances, remaining, type Allowance } from '../lib/allowances'
import type { TokenInfo } from '../lib/chains'
import { formatAmount } from '../lib/format'
import { fetchTokenInfo } from '../lib/tokens'
import { useSafe } from '../state'
import { SpendForm } from './Allowances'

/** Allowances from every enabled Allowance Module, with token info. Shared by the Allowances, Send and Overview tabs. */
export function useAllowanceData() {
  const { chain, info } = useSafe()
  return useQuery({
    queryKey: ['allowances', chain.id, info.address, info.modules.join(','), info.nonce.toString()],
    queryFn: async () => {
      const perModule = await loadAllAllowances(chain.id, info.address, info.modules)
      const allowances = perModule.flatMap((m) => m.allowances)
      const uniq = [...new Set(allowances.map((a) => a.token.toLowerCase()))] as Address[]
      const infos = await Promise.all(uniq.map((t) => fetchTokenInfo(chain.id, t)))
      const tokens: Record<string, TokenInfo> = {}
      uniq.forEach((t, i) => (tokens[t] = infos[i]))
      return { perModule, allowances, tokens }
    },
  })
}

/** The connected wallet's own allowances on this Safe (empty when not a member). */
export function useMyAllowances(): { mine: Allowance[]; tokens: Record<string, TokenInfo>; refetch: () => unknown } {
  const { address: account } = useAccount()
  const data = useAllowanceData()
  const mine = (data.data?.allowances ?? []).filter((a) => !!account && isAddressEqual(a.delegate, account) && a.amount > 0n)
  return { mine, tokens: data.data?.tokens ?? {}, refetch: () => data.refetch() }
}

/** Spend forms for each of the connected wallet's allowances. */
export function MyAllowanceSpend() {
  const { mine, tokens, refetch } = useMyAllowances()
  return (
    <>
      {mine.map((a) => (
        <SpendForm key={`${a.module}-${a.token}`} allowance={a} token={tokens[a.token.toLowerCase()]} onDone={refetch} />
      ))}
    </>
  )
}

/** One-line summary for the Overview tab. */
export function MyAllowanceNotice() {
  const { setTab } = useSafe()
  const { mine, tokens } = useMyAllowances()
  if (mine.length === 0) return null
  const parts = mine.map((a) => {
    const t = tokens[a.token.toLowerCase()]
    return t ? `${formatAmount(remaining(a), t.decimals)} ${t.symbol}` : ''
  })
  return (
    <p className="status ok">
      You have an allowance on this Safe: {parts.filter(Boolean).join(', ')} left. You can send it without collecting signatures.{' '}
      <button type="button" className="link" onClick={() => setTab('send')}>
        Send from my allowance
      </button>
    </p>
  )
}
