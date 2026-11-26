import type { Address } from 'viem'

export interface AllowanceModuleDeployment {
  version: string
  address: Address
  /** Recommended for new setups. */
  standard: boolean
  note: string
  /** Chains where this version was never deployed (checked with eth_getCode). */
  missingOn?: number[]
}

/**
 * Every Allowance Module deployment. Each version uses the same address on every chain where it
 * exists; `missingOn` lists the supported chains where it does not (run `npm run verify:chains`).
 * A Safe may have any of them enabled, so the app detects which one is active instead of assuming.
 */
export const ALLOWANCE_MODULES: AllowanceModuleDeployment[] = [
  {
    version: '1.0.0',
    address: '0x691f59471Bfd2B7d639DCF74671a2d648ED1E331',
    standard: true,
    note: 'Latest. Fixes a nonce overflow (replay) and failed-transfer handling for tokens that return false.',
  },
  {
    version: '0.1.1',
    address: '0xAA46724893dedD72658219405185Fb0Fc91e091C',
    standard: false,
    note: 'Legacy deployment used by Safe{Wallet} on Base, Gnosis and Optimism.',
    missingOn: [42220],
  },
  {
    version: '0.1.0',
    address: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134',
    standard: false,
    note: 'Original deployment used by Safe{Wallet} on Ethereum.',
  },
]

export const STANDARD_ALLOWANCE_MODULE = ALLOWANCE_MODULES.find((m) => m.standard)!

/** Allowance Module versions deployed on a given chain. */
export function allowanceModulesOn(chainId: number): AllowanceModuleDeployment[] {
  return ALLOWANCE_MODULES.filter((m) => !m.missingOn?.includes(chainId))
}

export function allowanceModuleByAddress(address: string): AllowanceModuleDeployment | undefined {
  return ALLOWANCE_MODULES.find((m) => m.address.toLowerCase() === address.toLowerCase())
}

/** Canonical MultiSendCallOnly v1.4.1 (deployed on every supported chain; see test/chains.verify.test.ts). */
export const MULTI_SEND_CALL_ONLY: Address = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2'

export const SENTINEL: Address = '0x0000000000000000000000000000000000000001'
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/** Allowance reset periods are stored as uint16 minutes. */
export const MAX_RESET_MINUTES = 65535
export const MAX_UINT96 = (1n << 96n) - 1n

export const RESET_PRESETS: { label: string; minutes: number }[] = [
  { label: 'One-time (never resets)', minutes: 0 },
  { label: 'Daily', minutes: 60 * 24 },
  { label: 'Weekly', minutes: 60 * 24 * 7 },
  { label: 'Every 2 weeks', minutes: 60 * 24 * 14 },
  { label: 'Every 30 days', minutes: 60 * 24 * 30 },
  { label: 'Every 45 days (max)', minutes: MAX_RESET_MINUTES },
]
