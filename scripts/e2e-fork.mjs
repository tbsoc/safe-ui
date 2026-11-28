/**
 * Browser end-to-end test: drives the built app against a local fork with test wallets.
 *
 *   Base:   npm run fork                 then  npm run e2e:fork
 *   Gnosis: FORK_CHAIN=gno npm run fork  then  FORK_CHAIN=gno npm run e2e:fork
 *
 * Ethereum, Optimism, Celo: FORK_CHAIN=eth|oeth|celo FORK_SAFE=0x… (any Safe; only the fork is touched)
 *
 * The site is served by `vite preview`, so the real /api/safe-queue and /api/names handlers run, pointed
 * at a local stand-in for Safe's Queue Service. Owners open the Safe's queue page and see each other's
 * signatures through the shared queue.
 *
 * Test keys are added as extra owners of the Bread Safe (on the fork only), as many as the
 * threshold. Owner 1 creates an allowance in the UI and signs, the others open the Safe's queue one
 * after another and sign, the last one executes. Then the member spends from the allowance.
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { createTestClient, createPublicClient, createWalletClient, encodeFunctionData, getAddress, hashTypedData, http, parseAbi, parseEther, recoverAddress, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, celo, gnosis, mainnet, optimism } from 'viem/chains'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const WETH_FUND = 'weth'
const NATIVE = '0x0000000000000000000000000000000000000000'
const CHAINS = {
  base: {
    chain: base,
    short: 'base',
    safe: '0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A', // love.fund
    token: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', fund: WETH_FUND },
  },
  gno: {
    chain: gnosis,
    short: 'gno',
    safe: '0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad', // Bread Coop core team (holds BREAD already)
    token: { address: '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3', symbol: 'BREAD' },
  },
  // Override any default with FORK_SAFE=0x… (only the local fork is touched).
  eth: {
    chain: mainnet,
    short: 'eth',
    safe: '0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A', // love.fund (v1.5.0, fresh)
    token: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', fund: WETH_FUND },
  },
  oeth: {
    chain: optimism,
    short: 'oeth',
    safe: '0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad', // core team address (v1.3.0 on Optimism)
    token: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', fund: WETH_FUND },
  },
  celo: {
    chain: celo,
    short: 'celo',
    safe: '0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad', // core team address (v1.3.0 on Celo)
    token: { address: NATIVE, symbol: 'CELO', fund: 'native' },
  },
}
const MODULES = [
  { address: '0x691f59471Bfd2B7d639DCF74671a2d648ED1E331', version: '1.0.0' },
  { address: '0xAA46724893dedD72658219405185Fb0Fc91e091C', version: '0.1.1' },
  { address: '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134', version: '0.1.0' },
]
const cfg = CHAINS[process.env.FORK_CHAIN || 'base']
if (!cfg) throw new Error(`Unknown FORK_CHAIN; use one of ${Object.keys(CHAINS).join(', ')}`)
cfg.safe = process.env.FORK_SAFE || cfg.safe
if (!cfg.safe) throw new Error(`Set FORK_SAFE=0x… to a Safe on ${cfg.chain.name}`)
const RPC = 'http://127.0.0.1:8545'
const SAFE = cfg.safe
const TOKEN = cfg.token.address
const RECIPIENT = '0x000000000000000000000000000000000000bEEF'
// The app collects signatures through the shared queue, so the run always serves the site with the proxy.
const SHARED = true
const distDir = resolve(process.argv[2] ?? 'dist-fork')
const shots = process.argv[3] ? resolve(process.argv[3]) : undefined

const ownerKeys = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
]
const accts = {
  member: privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'),
  proposer: privateKeyToAccount('0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97'),
}
ownerKeys.forEach((k, i) => (accts[`owner${i + 1}`] = privateKeyToAccount(k)))

const pub = createPublicClient({ chain: cfg.chain, transport: http(RPC) })
const test = createTestClient({ chain: cfg.chain, mode: 'hardhat', transport: http(RPC) })
const safeAbi = parseAbi([
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

async function asSafe(to, data, value = 0n) {
  const bal = await pub.getBalance({ address: SAFE })
  if (bal < parseEther('100')) await test.setBalance({ address: SAFE, value: bal + parseEther('100') })
  await test.impersonateAccount({ address: SAFE })
  const hash = await test.request({ method: 'eth_sendTransaction', params: [{ from: SAFE, to, data, value: `0x${value.toString(16)}` }] })
  await pub.waitForTransactionReceipt({ hash })
  await test.stopImpersonatingAccount({ address: SAFE })
}

let threshold = 0
let ownerCount = 0
async function setupFork() {
  for (const a of Object.values(accts)) await test.setBalance({ address: a.address, value: parseEther('1000') })
  threshold = Number(await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'getThreshold' }))
  for (let i = 1; i <= threshold; i++) {
    await asSafe(SAFE, encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [accts[`owner${i}`].address, BigInt(threshold)] }))
  }
  ownerCount = (await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'getOwners' })).length
  const guard = await pub.getStorageAt({ address: SAFE, slot: '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8' })
  if (guard && BigInt(guard) !== 0n) throw new Error('This Safe has a transaction guard; pick another one for the test')
  if (cfg.token.fund === WETH_FUND) {
    await test.setBalance({ address: SAFE, value: parseEther('5') })
    await asSafe(TOKEN, encodeFunctionData({ abi: parseAbi(['function deposit() payable']), functionName: 'deposit' }), parseEther('2'))
  } else if (cfg.token.fund === 'native') {
    await test.setBalance({ address: SAFE, value: parseEther('5') })
  }
  // Same rule as the app: newest enabled allowance module, else v1.0.0 (enabled by the first allowance).
  const [mods] = await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'getModulesPaginated', args: ['0x0000000000000000000000000000000000000001', 50n] })
  const enabled = MODULES.filter((m) => mods.some((x) => x.toLowerCase() === m.address.toLowerCase()))
  enabledCount = enabled.length
  expectModule = enabled[0] ? { ...enabled[0], alreadyEnabled: true } : { ...MODULES[0], alreadyEnabled: false }
  console.log(`  ${cfg.chain.name} Safe ${SAFE}: ${threshold} of ${ownerCount} (with test signers), ${mods.length} module(s), allowance module ${expectModule.alreadyEnabled ? 'v' + expectModule.version + ' enabled' : 'not enabled'}`)
}

let expectModule
let enabledCount = 0
const balanceOf = (a) =>
  TOKEN === NATIVE ? pub.getBalance({ address: a }) : pub.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [a] })

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    try {
      const file = path === '/' ? 'index.html' : path
      const body = await readFile(join(dir, file))
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(await readFile(join(dir, 'index.html')))
    }
  })
  return new Promise((ok) => server.listen(0, () => ok(server)))
}

/** A page with an injected EIP-1193 wallet backed by a local key, talking to the fork. */
async function walletPage(browser, name) {
  const account = accts[name]
  const wallet = createWalletClient({ account, chain: cfg.chain, transport: http(RPC) })
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await context.exposeFunction('__wallet', async (method, params) => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address]
      case 'eth_chainId':
        return `0x${cfg.chain.id.toString(16)}`
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null
      case 'eth_signTypedData_v4': {
        const typed = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
        // Keep EIP712Domain: Safe's Queue Service uses a non-standard domain field (safe).
        return account.signTypedData({ domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: typed.message })
      }
      case 'eth_sendTransaction': {
        const t = params[0]
        return wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n, gas: t.gas ? BigInt(t.gas) : undefined })
      }
      default: {
        const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
        const body = await res.json()
        if (body.error) throw new Error(body.error.message)
        return body.result
      }
    }
  })
  await context.addInitScript(() => {
    const listeners = {}
    window.ethereum = {
      isMetaMask: true,
      request: ({ method, params }) => window.__wallet(method, params ?? []),
      on: (e, f) => ((listeners[e] ??= []).push(f)),
      removeListener: (e, f) => (listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)),
    }
  })
  const page = await context.newPage()
  openPages.push([name, page])
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message))
  return page
}

async function connect(page) {
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.locator('.menu-item').first().click()
  await page.locator('.pill', { hasText: '·' }).first().waitFor()
}

let step = 0
const openPages = []
async function shot(page, name) {
  if (shots) await page.screenshot({ path: join(shots, `${String(++step).padStart(2, '0')}-${name}.png`), fullPage: true })
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
  console.log(`  ✓ ${msg}`)
}


/** Minimal stand-in for Safe's Queue Service: same paths and fields, signatures recovered and checked. */
function mockQueueService() {
  const txs = new Map()
  const delegates = []
  const DELEGATE_TYPES = {
    EIP712Domain: [
      { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'safe', type: 'address' },
    ],
    Delegate: [{ name: 'delegateAddress', type: 'address' }, { name: 'totp', type: 'uint256' }, { name: 'action', type: 'string' }],
  }
  const delegateSigner = async (b, action) => {
    const hour = BigInt(Math.floor(Date.now() / 3600000))
    for (const totp of [hour, hour - 1n]) {
      const signer = await recoverTypedDataAddress({
        domain: { name: 'Safe Queue Service', version: '1.0', chainId: Number(b.chainId ?? 0), safe: b.safe ?? '0x0000000000000000000000000000000000000000' },
        types: DELEGATE_TYPES,
        primaryType: 'Delegate',
        message: { delegateAddress: b.delegate, totp, action },
        signature: b.signature,
      })
      if ([b.delegator, b.delegate].some((a) => a.toLowerCase() === signer.toLowerCase())) return signer
    }
    throw new Error('Invalid signature, TOTP expired, or not signed by delegator')
  }
  const TYPES = {
    SafeTx: [
      { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
  }
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const owners = async (safe) => (await pub.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })).map((o) => o.toLowerCase())
  const confirmation = async (hash, sig, safe) => {
    const owner = await recoverAddress({ hash, signature: sig })
    if (!(await owners(safe)).includes(owner.toLowerCase())) throw new Error('Signer is not a Safe owner')
    return { owner: getAddress(owner), signature: sig, signatureType: 'EOA' }
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    try {
      if (req.method === 'GET' && url.pathname === '/api/v1/multisig-transactions/queue') {
        const [safe, chainId] = url.searchParams.get('safes').split(':')
        const nonce = await pub.readContract({ address: safe, abi: parseAbi(['function nonce() view returns (uint256)']), functionName: 'nonce' })
        const results = [...txs.values()].filter((t) => t.safe.toLowerCase() === safe.toLowerCase() && t.chainId === Number(chainId) && BigInt(t.nonce) >= nonce)
        return send(res, 200, { count: results.length, next: null, previous: null, results })
      }
      if (url.pathname === '/api/v1/delegates') {
        if (req.method === 'GET') {
          const safe = url.searchParams.get('safe')?.toLowerCase()
          const delegate = url.searchParams.get('delegate')?.toLowerCase()
          const results = delegates.filter((d) => (!safe || d.safe?.toLowerCase() === safe) && (!delegate || d.delegate.toLowerCase() === delegate))
          return send(res, 200, { count: results.length, next: null, previous: null, results })
        }
        const signer = await delegateSigner(body, req.method === 'POST' ? 'add' : 'delete')
        if (req.method === 'POST') {
          if (signer.toLowerCase() !== body.delegator.toLowerCase()) throw new Error('Only the delegator can add')
          delegates.push({ delegate: body.delegate, delegator: body.delegator, safe: body.safe, chainId: body.chainId === null ? null : String(body.chainId), label: body.label ?? '' })
          return send(res, 201, delegates.at(-1))
        }
        if (req.method === 'DELETE') {
          const i = delegates.findIndex((d) => d.delegate.toLowerCase() === body.delegate.toLowerCase() && d.delegator.toLowerCase() === body.delegator.toLowerCase())
          if (i < 0) return send(res, 404, { detail: 'Not found' })
          delegates.splice(i, 1)
          res.writeHead(204)
          return res.end()
        }
      }
      const m = url.pathname.match(/^\/api\/v1\/multisig-transactions(?:\/(0x[0-9a-fA-F]{64}))?(\/signatures)?$/)
      if (!m) return send(res, 404, { detail: 'Not found' })
      const [, hash, sigs] = m
      if (req.method === 'GET' && hash && !sigs) return txs.has(hash) ? send(res, 200, txs.get(hash)) : send(res, 404, { detail: 'MultisigTransaction not found.' })
      if (req.method === 'POST' && !hash) {
        const t = { ...body, chainId: Number(body.chainId), nonce: String(body.nonce), txHash: null }
        const safeTxHash = hashTypedData({
          domain: { chainId: t.chainId, verifyingContract: t.safe },
          types: TYPES,
          primaryType: 'SafeTx',
          message: { ...t, value: BigInt(t.value), safeTxGas: BigInt(t.safeTxGas), baseGas: BigInt(t.baseGas), gasPrice: BigInt(t.gasPrice), nonce: BigInt(t.nonce) },
        })
        if (txs.has(safeTxHash)) return send(res, 409, { detail: 'Already exists' })
        const confirmations = []
        let proposedBy = null
        const first = await recoverAddress({ hash: safeTxHash, signature: body.signatures[0] })
        const owns = await owners(t.safe)
        if (!owns.includes(first.toLowerCase())) {
          // A proposer: exactly one signature, not stored as a confirmation, delegator must be an owner.
          const ok = delegates.some((d) => d.delegate.toLowerCase() === first.toLowerCase() && owns.includes(d.delegator.toLowerCase()) && (!d.safe || d.safe.toLowerCase() === t.safe.toLowerCase()))
          if (!ok || body.signatures.length !== 1) throw new Error('First signer is not a Safe owner, an authorized delegate or an owner of a Safe owning this Safe')
          proposedBy = getAddress(first)
        } else {
          for (const s of body.signatures) confirmations.push(await confirmation(safeTxHash, s, t.safe))
        }
        const { signatures: _s, ...rest } = t
        const stored = { ...rest, safeTxHash, confirmations, proposedBy }
        txs.set(safeTxHash, stored)
        return send(res, 201, stored)
      }
      if (req.method === 'POST' && hash && sigs) {
        const t = txs.get(hash)
        if (!t) return send(res, 404, { detail: 'MultisigTransaction not found.' })
        const added = []
        for (const s of body.signatures) {
          const c = await confirmation(hash, s, t.safe)
          if (t.confirmations.some((x) => x.owner === c.owner)) return send(res, 409, { detail: 'Already confirmed' })
          added.push(c)
        }
        t.confirmations.push(...added)
        return send(res, 201, added)
      }
      return send(res, 404, { detail: 'Not found' })
    } catch (e) {
      return send(res, 422, { detail: e.message })
    }
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, txs, url: `http://127.0.0.1:${server.address().port}` })))
}

async function main() {
  await setupFork()
  let server
  let origin
  let mock
  if (SHARED) {
    // Serve with `vite preview` so the real /api/safe-queue proxy (vite.config.ts) handles the calls.
    mock = await mockQueueService()
    process.env.SAFE_API_KEY = 'test-key'
    process.env.SAFE_QUEUE_UPSTREAM = mock.url
    process.env.NAME_EDITORS = `${cfg.chain.id}:${SAFE}`
    // The address book checks signers on-chain: point that lookup at the fork, where the test signers exist.
    process.env[`VITE_RPC_URL_${cfg.chain.id}`] = RPC
    const { preview } = await import('vite')
    const pv = await preview({ build: { outDir: distDir }, preview: { port: 4174, host: '127.0.0.1', strictPort: false }, logLevel: 'error' })
    origin = pv.resolvedUrls.local[0].replace(/\/$/, '')
    server = { close: () => (pv.close(), mock.server.close()) }
  } else {
    server = await serve(distDir)
    origin = `http://127.0.0.1:${server.address().port}`
  }
  const browser = await chromium.launch()
  const sym = cfg.token.symbol
  try {
    // Owner 1: overview, then create an allowance.
    const p1 = await walletPage(browser, 'owner1')
    await p1.goto(`${origin}/?safe=${cfg.short}:${SAFE}`)
    await p1.getByText(`${threshold} of ${ownerCount} required`).waitFor({ timeout: 60_000 })
    await connect(p1)
    await shot(p1, 'overview')

    await p1.getByRole('tab', { name: 'Allowances' }).click()
    if (enabledCount > 1) {
      await p1.locator('td', { hasText: sym }).first().waitFor({ timeout: 60_000 })
      assert(await p1.locator('th', { hasText: 'Module' }).isVisible(), 'allowance table shows which module each allowance lives on')
      assert((await p1.locator('#al-module').inputValue()).toLowerCase() === expectModule.address.toLowerCase(), `new allowances default to v${expectModule.version}`)
      await shot(p1, 'existing-allowances')
    } else if (!expectModule.alreadyEnabled) {
      await p1.getByText('not enabled yet').waitFor()
    }
    await p1.locator('#al-delegate').fill(accts.member.address)
    await p1.locator('#al-token').selectOption({ label: sym })
    await p1.locator('#al-amount').fill('1')
    await p1.locator('#al-period').selectOption({ label: 'Every 30 days' })
    await p1.getByText('Set the allowance amount and reset period').waitFor()
    const enables = await p1.getByText('Enable the Allowance Module on this Safe').isVisible()
    assert(enables === !expectModule.alreadyEnabled, expectModule.alreadyEnabled ? 'no extra module gets enabled' : 'first allowance enables the module')
    await shot(p1, 'allowance-form')
    await p1.getByRole('button', { name: 'Create transaction' }).click()
    await p1.getByText(`Confirmations 0/${threshold}`).waitFor()
    assert(await p1.getByText(`Allowance Module v${expectModule.version} · setAllowance`).isVisible(), `queue decodes setAllowance on v${expectModule.version}`)

    // Each owner signs; the last one executes. Link mode passes the newest link on.
    // Shared mode: every owner just opens the Safe's queue page and finds the transaction there.
    let page = p1
    for (let i = 1; i <= threshold; i++) {
      if (i > 1) {
        const link = `${origin}/?safe=${cfg.short}:${SAFE}&tab=queue`
        page = await walletPage(browser, `owner${i}`)
        await page.goto(link)
        await page.getByText(`Confirmations ${i - 1}/${threshold}`).waitFor({ timeout: 60_000 })
        await connect(page)
      }
      await page.getByRole('button', { name: 'Sign', exact: true }).click()
      await page.getByText(`Confirmations ${i}/${threshold}`).waitFor()
      if (SHARED) await page.getByText('Saved to the shared queue').waitFor({ timeout: 30_000 })
    }
    if (SHARED) {
      const stored = [...mock.txs.values()]
      assert(stored.length === 1 && stored[0].confirmations.length === threshold, `shared queue holds the transaction with all ${threshold} signatures`)
      assert(await page.getByText('in shared queue').isVisible(), 'card shows it is in the shared queue')
    }
    assert(true, `${threshold} owners signed via the shared queue`)
    await shot(page, 'queue-ready')
    if (SHARED) await shot(page, 'shared-queue-ready')
    await page.getByRole('button', { name: 'Execute' }).click()
    await page.getByText('View execution on explorer').waitFor({ timeout: 60_000 })
    await shot(page, 'executed')
    await page.getByRole('tab', { name: 'Allowances' }).click()
    await page.locator('td', { hasText: sym }).first().waitFor()
    assert(true, 'execution confirmed and allowance tab reloads')

    if (SHARED) {
      // Shared address book: a signer names the member; everyone sees the name.
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByLabel('Address to name').fill(accts.member.address)
      await page.getByLabel('Name', { exact: true }).fill('Alice')
      await page.getByRole('button', { name: 'Save name' }).click()
      await page.getByText('Saved.').waitFor({ timeout: 30_000 })
      await shot(page, 'address-book')
      await page.getByRole('tab', { name: 'Allowances' }).click()
      await page.locator('td .addr-name', { hasText: 'Alice' }).first().waitFor({ timeout: 30_000 })
      assert(true, 'signer named the member; the name shows in the allowances table')

      // Name lookup in address fields: type part of a name, pick it, the address is filled in.
      await page.getByRole('tab', { name: 'Send' }).click()
      await page.locator('#send-to').fill('ali')
      await page.getByRole('option', { name: /Alice/ }).click()
      assert((await page.locator('#send-to').inputValue()) === accts.member.address, 'typing "ali" and picking Alice fills in her address')
      assert(await page.getByText('✓ Alice').isVisible(), 'the field confirms the name of the entered address')
      await shot(page, 'name-lookup')
    }

    // Member spends 0.4 from the allowance.
    const m = await walletPage(browser, 'member')
    await m.goto(`${origin}/?safe=${cfg.short}:${SAFE}&tab=allowances`)
    await connect(m)
    await m.getByText('Spend your allowance').waitFor({ timeout: 60_000 })
    const before = await balanceOf(RECIPIENT)
    await m.getByLabel('Recipient', { exact: true }).fill(RECIPIENT)
    await m.getByPlaceholder(`Amount ${sym}`).fill('0.4')
    await shot(m, 'member-spend')
    await m.getByRole('button', { name: 'Send', exact: true }).click()
    await m.getByText('View transaction').waitFor({ timeout: 60_000 })
    const after = await balanceOf(RECIPIENT)
    assert(after - before === parseEther('0.4'), `recipient received 0.4 ${sym}`)
    await m.getByText(`0.6 ${sym}`).first().waitFor()
    await shot(m, 'member-after-spend')
    assert(true, `remaining allowance shows 0.6 ${sym}`)

    await m.getByPlaceholder(`Amount ${sym}`).fill('0.7')
    assert(await m.getByText('That is more than your remaining allowance.').isVisible(), 'over-limit amount is rejected in the form')

    // The member can also spend from the Send tab (and sees a notice on Overview).
    await m.goto(`${origin}/?safe=${cfg.short}:${SAFE}`)
    await m.getByText('You have an allowance on this Safe').waitFor({ timeout: 60_000 })
    await m.getByRole('button', { name: 'Send from my allowance' }).click()
    await m.getByLabel('Recipient', { exact: true }).fill(RECIPIENT)
    await m.getByPlaceholder(`Amount ${sym}`).fill('0.1')
    const before3 = await balanceOf(RECIPIENT)
    await m.getByRole('button', { name: 'Send', exact: true }).click()
    await m.getByText('View transaction').waitFor({ timeout: 60_000 })
    assert((await balanceOf(RECIPIENT)) - before3 === parseEther('0.1'), 'member spent 0.1 from the Send tab')
    await m.getByText(`0.5 ${sym}`).first().waitFor()
    await shot(m, 'member-send-tab')

    if (SHARED) {
      // An owner adds a proposer; the proposer proposes a payment; owners sign it from the shared queue.
      const o1 = await walletPage(browser, 'owner1')
      await o1.goto(`${origin}/?safe=${cfg.short}:${SAFE}`)
      await connect(o1)
      await o1.getByLabel('Proposer address').fill(accts.proposer.address)
      await o1.getByLabel('Proposer name').fill('Treasurer')
      await o1.getByRole('button', { name: 'Add proposer' }).click()
      await o1.getByText('Proposer added.').waitFor({ timeout: 30_000 })
      await o1.getByText('Treasurer').waitFor()
      await shot(o1, 'proposer-added')
      assert(true, 'owner added a proposer with a signed message')

      const pr = await walletPage(browser, 'proposer')
      await pr.goto(`${origin}/?safe=${cfg.short}:${SAFE}&tab=send`)
      await connect(pr)
      await pr.locator('#send-token').waitFor({ timeout: 30_000 })
      await pr.locator('#send-token').selectOption({ label: sym })
      await pr.locator('#send-to').fill(RECIPIENT)
      await pr.locator('#send-amount').fill('0.1')
      await pr.getByRole('button', { name: 'Create transaction' }).click()
      assert(!(await pr.getByRole('button', { name: 'Sign', exact: true }).isVisible()), 'proposer gets no Sign button')
      await pr.getByRole('button', { name: 'Propose to shared queue' }).click()
      await pr.getByText('Proposed. It is in the shared queue').waitFor({ timeout: 30_000 })
      await shot(pr, 'proposer-proposed')
      const proposed = [...mock.txs.values()].find((t) => t.proposedBy)
      assert(proposed && proposed.confirmations.length === 0, 'proposal is in the shared queue with 0 confirmations')

      const before2 = await balanceOf(RECIPIENT)
      let pg
      for (let i = 1; i <= threshold; i++) {
        pg = await walletPage(browser, `owner${i}`)
        await pg.goto(`${origin}/?safe=${cfg.short}:${SAFE}&tab=queue`)
        await pg.getByText(`Confirmations ${i - 1}/${threshold}`).waitFor({ timeout: 60_000 })
        await connect(pg)
        await pg.getByRole('button', { name: 'Sign', exact: true }).click()
        await pg.getByText('Saved to the shared queue').waitFor({ timeout: 30_000 })
      }
      await pg.getByRole('button', { name: 'Execute' }).click()
      await pg.getByText('View execution on explorer').waitFor({ timeout: 60_000 })
      assert((await balanceOf(RECIPIENT)) - before2 === parseEther('0.1'), `proposer's payment executed after ${threshold} owner signatures`)
    }

    console.log(`\nAll browser checks passed on ${cfg.chain.name} (module v${expectModule.version}).`)
  } catch (e) {
    for (const [name, pg] of openPages) {
      const errs = await pg.locator('.status').allTextContents().catch(() => [])
      console.log(`[${name}] status messages:`, errs)
      if (shots) await pg.screenshot({ path: join(shots, `fail-${name}.png`), fullPage: true }).catch(() => {})
    }
    throw e
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
