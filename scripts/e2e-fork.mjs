/**
 * Browser end-to-end test: drives the built app against a local fork with test wallets.
 *
 *   Base:   npm run fork                 then  npm run e2e:fork
 *   Gnosis: FORK_CHAIN=gno npm run fork  then  FORK_CHAIN=gno npm run e2e:fork
 *
 * Test keys are added as extra owners of the Bread Safe (on the fork only), as many as the
 * threshold. Owner 1 creates an allowance in the UI and signs, the others open the share link one
 * after another and sign, the last one executes. Then the member spends from the allowance.
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { createTestClient, createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, gnosis } from 'viem/chains'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const CHAINS = {
  base: {
    chain: base,
    short: 'base',
    safe: '0x6406a78cef5D0E90d3aF1Ac505D0CA85109c102A',
    token: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' },
    // Fresh Safe: the first allowance enables Allowance Module v1.0.0.
    expectModule: { address: '0x691f59471Bfd2B7d639DCF74671a2d648ED1E331', version: '1.0.0', alreadyEnabled: false },
  },
  gno: {
    chain: gnosis,
    short: 'gno',
    safe: '0x918dEf5d593F46735f74F9E2B280Fe51AF3A99ad',
    token: { address: '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3', symbol: 'BREAD' },
    // Core team Safe: v0.1.0 and v0.1.1 already enabled; new allowances go to v0.1.1.
    expectModule: { address: '0xAA46724893dedD72658219405185Fb0Fc91e091C', version: '0.1.1', alreadyEnabled: true },
  },
}
const cfg = CHAINS[process.env.FORK_CHAIN || 'base']
const RPC = 'http://127.0.0.1:8545'
const SAFE = cfg.safe
const TOKEN = cfg.token.address
const RECIPIENT = '0x000000000000000000000000000000000000bEEF'
const distDir = resolve(process.argv[2] ?? 'dist-fork')
const shots = process.argv[3] ? resolve(process.argv[3]) : undefined

const ownerKeys = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
]
const accts = { member: privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a') }
ownerKeys.forEach((k, i) => (accts[`owner${i + 1}`] = privateKeyToAccount(k)))

const pub = createPublicClient({ chain: cfg.chain, transport: http(RPC) })
const test = createTestClient({ chain: cfg.chain, mode: 'hardhat', transport: http(RPC) })
const safeAbi = parseAbi([
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

async function asSafe(to, data, value = 0n) {
  const bal = await pub.getBalance({ address: SAFE })
  if (bal < parseEther('1')) await test.setBalance({ address: SAFE, value: bal + parseEther('1') })
  await test.impersonateAccount({ address: SAFE })
  const hash = await test.request({ method: 'eth_sendTransaction', params: [{ from: SAFE, to, data, value: `0x${value.toString(16)}` }] })
  await pub.waitForTransactionReceipt({ hash })
  await test.stopImpersonatingAccount({ address: SAFE })
}

let threshold = 0
let ownerCount = 0
async function setupFork() {
  for (const a of Object.values(accts)) await test.setBalance({ address: a.address, value: parseEther('10') })
  threshold = Number(await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'getThreshold' }))
  for (let i = 1; i <= threshold; i++) {
    await asSafe(SAFE, encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [accts[`owner${i}`].address, BigInt(threshold)] }))
  }
  ownerCount = (await pub.readContract({ address: SAFE, abi: safeAbi, functionName: 'getOwners' })).length
  if (!cfg.expectModule.alreadyEnabled) {
    // Fresh Base Safe holds nothing: give it 2 WETH.
    await test.setBalance({ address: SAFE, value: parseEther('5') })
    await asSafe(TOKEN, encodeFunctionData({ abi: parseAbi(['function deposit() payable']), functionName: 'deposit' }), parseEther('2'))
  }
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
  const sym = cfg.token.symbol
  try {
    // Owner 1: overview, then create an allowance.
    const p1 = await walletPage(browser, 'owner1')
    await p1.goto(`${origin}/?safe=${cfg.short}:${SAFE}`)
    await p1.getByText(`${threshold} of ${ownerCount} required`).waitFor({ timeout: 60_000 })
    await connect(p1)
    await shot(p1, 'overview')

    await p1.getByRole('tab', { name: 'Allowances' }).click()
    if (cfg.expectModule.alreadyEnabled) {
      await p1.locator('td', { hasText: sym }).first().waitFor({ timeout: 60_000 })
      assert(await p1.locator('th', { hasText: 'Module' }).isVisible(), 'allowance table shows which module each allowance lives on')
      assert((await p1.locator('#al-module').inputValue()).toLowerCase() === cfg.expectModule.address.toLowerCase(), `new allowances default to v${cfg.expectModule.version}`)
      await shot(p1, 'existing-allowances')
    } else {
      await p1.getByText('not enabled yet').waitFor()
    }
    await p1.locator('#al-delegate').fill(accts.member.address)
    await p1.locator('#al-token').selectOption({ label: sym })
    await p1.locator('#al-amount').fill('1')
    await p1.locator('#al-period').selectOption({ label: 'Every 30 days' })
    await p1.getByText('Set the allowance amount and reset period').waitFor()
    const enables = await p1.getByText('Enable the Allowance Module on this Safe').isVisible()
    assert(enables === !cfg.expectModule.alreadyEnabled, cfg.expectModule.alreadyEnabled ? 'no extra module gets enabled' : 'first allowance enables the module')
    await shot(p1, 'allowance-form')
    await p1.getByRole('button', { name: 'Create transaction' }).click()
    await p1.getByText(`Confirmations 0/${threshold}`).waitFor()
    assert(await p1.getByText(`Allowance Module v${cfg.expectModule.version} · setAllowance`).isVisible(), `queue decodes setAllowance on v${cfg.expectModule.version}`)

    // Each owner signs and passes the link on; the last one executes.
    let page = p1
    for (let i = 1; i <= threshold; i++) {
      if (i > 1) {
        const link = await copyShareLink(page)
        page = await walletPage(browser, `owner${i}`)
        await page.goto(link)
        await page.getByText(`Confirmations ${i - 1}/${threshold}`).waitFor({ timeout: 60_000 })
        await connect(page)
      }
      await page.getByRole('button', { name: 'Sign', exact: true }).click()
      await page.getByText(`Confirmations ${i}/${threshold}`).waitFor()
    }
    assert(true, `${threshold} owners signed via share links`)
    await shot(page, 'queue-ready')
    await page.getByRole('button', { name: 'Execute' }).click()
    await page.getByText('View execution on explorer').waitFor({ timeout: 60_000 })
    await shot(page, 'executed')
    await page.getByRole('tab', { name: 'Allowances' }).click()
    await page.locator('td', { hasText: sym }).first().waitFor()
    assert(true, 'execution confirmed and allowance tab reloads')

    // Member spends 0.4 from the allowance.
    const m = await walletPage(browser, 'member')
    await m.goto(`${origin}/?safe=${cfg.short}:${SAFE}&tab=allowances`)
    await connect(m)
    await m.getByText('Spend your allowance').waitFor({ timeout: 60_000 })
    const before = await pub.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [RECIPIENT] })
    await m.getByPlaceholder('Recipient 0x…').fill(RECIPIENT)
    await m.getByPlaceholder(`Amount ${sym}`).fill('0.4')
    await shot(m, 'member-spend')
    await m.getByRole('button', { name: 'Send', exact: true }).click()
    await m.getByText('View transaction').waitFor({ timeout: 60_000 })
    const after = await pub.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [RECIPIENT] })
    assert(after - before === parseEther('0.4'), `recipient received 0.4 ${sym}`)
    await m.getByText(`0.6 ${sym}`).first().waitFor()
    await shot(m, 'member-after-spend')
    assert(true, `remaining allowance shows 0.6 ${sym}`)

    await m.getByPlaceholder(`Amount ${sym}`).fill('0.7')
    assert(await m.getByText('That is more than your remaining allowance.').isVisible(), 'over-limit amount is rejected in the form')

    console.log(`\nAll browser checks passed on ${cfg.chain.name} (module v${cfg.expectModule.version}).`)
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
