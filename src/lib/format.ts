import { formatUnits, parseUnits } from 'viem'

export function shortAddress(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function formatAmount(value: bigint, decimals: number, maxFraction = 4): string {
  const s = formatUnits(value, decimals)
  const [int, frac = ''] = s.split('.')
  const intFmt = BigInt(int).toLocaleString('en-US')
  const fracTrim = frac.slice(0, maxFraction).replace(/0+$/, '')
  if (value > 0n && int === '0' && !fracTrim) return `<0.${'0'.repeat(maxFraction - 1)}1`
  return fracTrim ? `${intFmt}.${fracTrim}` : intFmt
}

/** Parse a user-typed decimal amount; returns undefined for invalid input. */
export function parseAmount(input: string, decimals: number): bigint | undefined {
  const s = input.trim().replace(/,/g, '')
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return undefined
  const [, frac = ''] = s.split('.')
  if (frac.length > decimals) return undefined
  try {
    return parseUnits(s, decimals)
  } catch {
    return undefined
  }
}

export function formatDateTime(unixSec: number) {
  return new Date(unixSec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function relativeTime(unixSec: number, nowSec = Date.now() / 1000) {
  const diff = unixSec - nowSec
  const abs = Math.abs(diff)
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ]
  for (const [secs, name] of units) {
    if (abs >= secs) {
      const n = Math.round(abs / secs)
      const label = `${n} ${name}${n === 1 ? '' : 's'}`
      return diff > 0 ? `in ${label}` : `${label} ago`
    }
  }
  return diff > 0 ? 'in under a minute' : 'just now'
}

export function errorMessage(e: unknown): string {
  if (!e) return 'Unknown error'
  const any = e as { shortMessage?: string; message?: string; details?: string }
  return any.shortMessage || any.details || any.message || String(e)
}
