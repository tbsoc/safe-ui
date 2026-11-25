/**
 * Browser end-to-end test: drives the built app against a local Base fork with test wallets.
 *
 *   1. npx hardhat --config hardhat.config.cjs node            (fresh fork of Base)
 *   2. VITE_RPC_URL_8453=http://127.0.0.1:8545 npx vite build --outDir dist-fork
 *   3. node scripts/e2e-fork.mjs dist-fork [screenshotDir]
 *
 * Three test keys are added as extra owners of the Bread Safe (on the fork only). Owner A creates an
 * allowance in the UI and signs, B and C open the share link, sign, and C executes. Then the member
 * spends from the allowance in the UI.
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { createTestClient, createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const RPC = 'http://127.0.0.1:8545'
const SAFE = '0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A'
const WETH = '0x4200000000000000000000000000000000000006'
const MODULE = '0x691f59471Bfd2B7d639DCF74671a2d648ED1E331'
const RECIPIENT = '0x000000000000000000000000000000000000bEEF'
const distDir = resolve(process.argv[2] ?? 'dist-fork')
const shots = process.argv[3] ? resolve(process.argv[3]) : undefined

const keys = {
  A: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  B: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  C: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  member: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
}
const accts = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v)]))

const pub = createPublicClient({ chain: base, transport: http(RPC) })
const test = createTestClient({ chain: base, mode: 'hardhat', transport: http(RPC) })
const safeAbi = parseAbi(['function addOwnerWithThreshold(address owner, uint256 _threshold)'])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

async function asSafe(to, data, value = 0n) {
  await test.impersonateAccount({ address: SAFE })
  const hash = await test.request({ method: 'eth_sendTransaction', params: [{ from: SAFE, to, data, value: `0x${value.toString(16)}` }] })
  await pub.waitForTransactionReceipt({ hash })
  await test.stopImpersonatingAccount({ address: SAFE })
}

async function setupFork() {
  for (const a of Object.values(accts)) await test.setBalance({ address: a.address, value: parseEther('10') })
  await test.setBalance({ address: SAFE, value: parseEther('5') })
  for (const k of ['A', 'B', 'C']) {
    await asSafe(SAFE, encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [accts[k].address, 3n] }))
  }
  await asSafe(WETH, encodeFunctionData({ abi: parseAbi(['function deposit() payable']), functionName: 'deposit' }), parseEther('2'))
}

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
  const wallet = createWalletClient({ account, chain: base, transport: http(RPC) })
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await context.exposeFunction('__wallet', async (method, params) => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address]
      case 'eth_chainId':
        return '0x2105'
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null
      case 'eth_signTypedData_v4': {
        const typed = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
        const { EIP712Domain: _drop, ...types } = typed.types
        return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message })
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

async function copyShareLink(page) {
  await page.getByRole('button', { name: 'Copy share link' }).first().click()
  return page.evaluate(() => navigator.clipboard.readText())
}

async function main() {
  await setupFork()
  const server = await serve(distDir)
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch()
  try {
    // Owner A: overview, then create an allowance.
    const a = await walletPage(browser, 'A')
    await a.goto(`${origin}/?safe=base:${SAFE}`)
    await a.getByText('3 of 8 required').waitFor()
    await connect(a)
    await shot(a, 'overview')
    assert(await a.getByText('No modules enabled.').isVisible(), 'overview shows no modules')

    await a.getByRole('tab', { name: 'Allowances' }).click()
    await a.getByText('not enabled yet').waitFor()
    await a.locator('#al-delegate').fill(accts.member.address)
    await a.locator('#al-token').selectOption({ label: 'WETH' })
    await a.locator('#al-amount').fill('1')
    await a.locator('#al-period').selectOption({ label: 'Every 30 days' })
    await a.getByText('Enable the Allowance Module on this Safe').waitFor()
    await shot(a, 'allowance-form')
    await a.getByRole('button', { name: 'Create transaction' }).click()
    await a.getByText('Confirmations 0/3').waitFor()
    assert(await a.getByText('Allowance Module v1.0.0 · setAllowance').isVisible(), 'queue decodes the batched setAllowance')
    await a.getByRole('button', { name: 'Sign', exact: true }).click()
    await a.getByText('Confirmations 1/3').waitFor()
    await shot(a, 'queue-signed-by-a')
    const linkA = await copyShareLink(a)
    assert(linkA.includes('#tx='), 'share link carries the transaction')

    // Owner B opens the link and signs.
    const b = await walletPage(browser, 'B')
    await b.goto(linkA)
    await b.getByText('Confirmations 1/3').waitFor()
    await connect(b)
    await b.getByRole('button', { name: 'Sign', exact: true }).click()
    await b.getByText('Confirmations 2/3').waitFor()
    const linkB = await copyShareLink(b)

    // Owner C opens B's link, signs and executes.
    const c = await walletPage(browser, 'C')
    await c.goto(linkB)
    await c.getByText('Confirmations 2/3').waitFor()
    await connect(c)
    await c.getByRole('button', { name: 'Sign', exact: true }).click()
    await c.getByText('Confirmations 3/3').waitFor()
    await shot(c, 'queue-ready')
    await c.getByRole('button', { name: 'Execute' }).click()
    await c.getByText('View execution on explorer').waitFor({ timeout: 60_000 })
    await c.getByRole('tab', { name: 'Allowances' }).click()
    await c.locator('.tag.ok', { hasText: 'enabled' }).waitFor()
    await c.locator('td', { hasText: 'WETH' }).waitFor()
    await shot(c, 'allowances-active')
    assert(true, 'module enabled and allowance listed after execution')

    // Member spends 0.4 WETH from the allowance.
    const m = await walletPage(browser, 'member')
    await m.goto(`${origin}/?safe=base:${SAFE}&tab=allowances`)
    await connect(m)
    await m.getByText('Spend your allowance').waitFor()
    const before = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [RECIPIENT] })
    await m.getByPlaceholder('Recipient 0x…').fill(RECIPIENT)
    await m.getByPlaceholder('Amount WETH').fill('0.4')
    await shot(m, 'member-spend')
    await m.getByRole('button', { name: 'Send', exact: true }).click()
    await m.getByText('View transaction').waitFor({ timeout: 60_000 })
    const after = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [RECIPIENT] })
    assert(after - before === parseEther('0.4'), 'recipient received 0.4 WETH')
    await m.getByText('0.6 WETH').first().waitFor()
    await shot(m, 'member-after-spend')
    assert(true, 'remaining allowance shows 0.6 WETH')

    // Over-limit spend is refused before reaching the wallet.
    await m.getByPlaceholder('Amount WETH').fill('0.7')
    assert(await m.getByText('That is more than your remaining allowance.').isVisible(), 'over-limit amount is rejected in the form')

    console.log(`\nAll browser checks passed (module ${MODULE}).`)
  } catch (e) {
    for (const [name, page] of openPages) {
      const errs = await page.locator('.status').allTextContents().catch(() => [])
      console.log(`[${name}] status messages:`, errs)
      if (shots) await page.screenshot({ path: join(shots, `fail-${name}.png`), fullPage: true }).catch(() => {})
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
