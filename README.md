# Bread Safe

A small, open-source interface for Bread Cooperative's [Safe](https://safe.global) multisigs on **Ethereum, Base, Gnosis, Optimism and Celo**, with full support for the Safe **Allowance Module** (spending limits).

Safe{Wallet} now requires a paid plan to add new spending limits. The limits themselves live in a public smart contract, so this app talks to that contract directly.

- No backend, no accounts, no API keys. It reads the chain through public RPCs.
- Works with Safe contracts v1.3.0 and newer (the Bread Base Safe runs v1.5.0).
- Static site: deploys to Vercel or Netlify as-is.

## What it does

| Tab | What you can do |
| --- | --- |
| Overview | Balances, signers and threshold, nonce, enabled modules. The header lists the same address on other chains with each one's threshold |
| Send | Propose a native-token or ERC-20 transfer |
| Allowances | Owners: set, edit, reset, delete allowances and remove members. Members: spend from their allowance |
| Queue | Sign, approve on-chain, execute, share links with other signers |
| History | Multisig and allowance events (from Blockscout, with an RPC fallback) |
| Settings | Add tokens, use your own RPC endpoints |

## How allowances work

The [Allowance Module](https://github.com/safe-global/safe-modules/tree/main/modules/allowances) is a single shared contract. A Safe enables it once, then owners give members ("delegates") a per-token allowance:

- **Owners** set an amount and a reset period with a normal multisig transaction. The first allowance also enables the module, all in one transaction.
- **Members** spend up to that amount on their own, without collecting signatures, by calling the module from their wallet.
- The allowance refills every period (daily, weekly, every 30 days…) or never (one-time).

This app uses **Allowance Module v1.0.0** (`0x691f59471Bfd2B7d639DCF74671a2d648ED1E331`, same address on all five chains) for new setups. It fixes a nonce overflow and the handling of tokens that return `false`. If a Safe already has a legacy version enabled (`0.1.0` at `0xCFbF…3134` or `0.1.1` at `0xAA46…091C`; v0.1.1 was never deployed on Celo), the app detects it and keeps using it. A Safe can have more than one enabled (the Bread core team Safe on Gnosis has both): the app lists allowances from all of them, sends every change to the module the allowance lives on, and defaults new allowances to the newest enabled one.

Limits of the contract worth knowing:

- The longest reset period is 65,535 minutes (about 45.5 days), so monthly works but quarterly does not.
- Periods are fixed intervals, not calendar months. You can align the schedule to a past date.
- Changing an amount does not clear what was already spent this period. Use "Reset spent" for that.
- Members must be regular wallets, or a Safe that calls the module itself. Smart-contract signatures are not accepted.

## How multisig signing works

1. Someone creates a transaction (Send or Allowances). It is checked against the Safe's own `getTransactionHash` before it is saved.
2. Each owner signs it for free in their wallet (EIP-712). Owners whose wallet cannot sign typed data can **Approve on-chain** instead.
3. Signatures are collected in the **shared queue**: Safe's own [Queue Service](https://docs.safe.global/core-api/safe-queue-service-overview), the same queue Safe{Wallet} uses. Signing saves your signature there; every signer's Queue tab picks it up within 30 seconds. Transactions created in Safe{Wallet} show up here too, and the other way round.
4. Once enough owners have confirmed, anyone can **Execute**. If an owner who has not signed executes, their execution counts as a confirmation.

Nothing from the shared queue is trusted blindly: every transaction is re-hashed and every signature is checked against the Safe's current signers before it is shown or counted. Signatures from Safe{Wallet} in the older eth_sign format are accepted.

**Share links are the backup.** "Copy share link" packs the transaction and its signatures into the part of the URL after `#`, which browsers never send to a server. Use them if the shared queue is down or not configured. Links are encoded, not encrypted: anyone with the link can read the transaction, but nobody can change it without invalidating the signatures.

### Proposers

Proposers (called "delegates" in Safe's API) can put transactions in a Safe's shared queue without being signers, for example a treasurer preparing payments. They cannot sign; signers still have to reach the threshold. Signers add or remove them in the Overview tab's Proposers card by signing a free message (no transaction). A proposer can remove themselves. Proposers live in Safe's Queue Service, so Safe{Wallet} shows the same list. They apply to one Safe on one network, and need the shared queue.

### The shared queue needs a Safe API key

Safe's API requires a key (free Builder plan: 50,000 requests a month, from the [developer dashboard](https://developer.safe.global)). The key must never be in the website's code, so a small server function holds it: `functions/api/safe-queue/[[path]].ts` (Cloudflare Pages Function), using `src/server/queueProxy.ts`. It forwards only the four calls the app needs: list the queue, read a transaction, propose, add signatures.

| Setting (Cloudflare: Settings → Variables and Secrets) | |
| --- | --- |
| `SAFE_API_KEY` (type: Secret) | Required. Your Safe API key. |
| `ALLOWED_SAFES` | Recommended. Comma-separated `chainId:0xSafe` (or `0xSafe` for every chain). Only these Safes can use the queue through your site, so nobody else can spend your API quota. Already set for the two Bread Safes in `wrangler.jsonc` (Workers). |

Without `SAFE_API_KEY` (or on a host without the function, like a plain static deploy), the app says the shared queue is off and falls back to share links.

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (shared queue: SAFE_API_KEY=… npm run dev)
npm run build      # outputs dist/
npm test           # unit tests
npm run lint
```

Optional build-time settings (Vercel/Netlify environment variables):

| Variable | Purpose |
| --- | --- |
| `VITE_WC_PROJECT_ID` | Enables WalletConnect (mobile wallets). Free project ID from [Reown](https://cloud.reown.com). Without it, only browser-extension wallets connect. |
| `VITE_RPC_URL_1`, `VITE_RPC_URL_8453`, `VITE_RPC_URL_100`, `VITE_RPC_URL_10`, `VITE_RPC_URL_42220` | Replace the default public RPCs for Ethereum, Base, Gnosis, Optimism, Celo. |

### Supported chains

| Chain | Prefix in links | Native token | Allowance Module versions deployed |
| --- | --- | --- | --- |
| Ethereum | `eth:` | ETH | 1.0.0, 0.1.1, 0.1.0 |
| Base | `base:` | ETH | 1.0.0, 0.1.1, 0.1.0 |
| Gnosis | `gno:` | xDAI | 1.0.0, 0.1.1, 0.1.0 |
| Optimism | `oeth:` (or `op:`) | ETH | 1.0.0, 0.1.1, 0.1.0 |
| Celo | `celo:` | CELO | 1.0.0, 0.1.0 |

`npm run verify:chains` checks all of this against the live chains: every RPC answers with the right chain id, every listed token matches its on-chain symbol and decimals, each module version is deployed exactly where the config says, and the MultiSend batching contract exists. Run it after editing `src/lib/chains.ts` or `src/lib/constants.ts`.

### Shared-queue tests

```bash
npm test                              # includes proxy + queue client unit tests
SAFE_API_KEY=… npm run test:queue     # live: reads real core team transactions through the proxy, checks hashes and signatures,
                                      # and confirms Safe refuses a proposal signed by a non-owner (nothing is stored)
FORK_CHAIN=gno npm run fork           # then:
FORK_CHAIN=gno npm run e2e:fork:shared  # browser: 5 owners sign with no links, via the real proxy and a local stand-in for Safe's service
```

### Fork tests

These run the real Bread Safes and modules on a local copy of the chain. They add test keys as extra owners on the fork only.

| Chain | Safe | What it covers |
| --- | --- | --- |
| Base (default) | `0x6406…102A`, fresh, no modules | First allowance enables v1.0.0 in one transaction |
| Gnosis (`FORK_CHAIN=gno`) | `0x918d…99ad`, core team, v0.1.0 + v0.1.1 enabled | Reads both modules, edits go to the right one, no third module added |
| Ethereum (`FORK_CHAIN=eth`) | `0x6406…102A`, Bread Cooperative, fresh v1.5.0 | Browser flow, first allowance enables v1.0.0 |
| Optimism / Celo (`FORK_CHAIN=oeth\|celo`) | `0x918d…99ad`, core team address, Safe v1.3.0 | Browser flow on v1.3.0 Safes. Celo uses a native CELO allowance |

```bash
npm run fork                    # terminal 1: local Base fork on :8545
npm run test:fork               # terminal 2: library-level end-to-end tests
# restart the fork for a clean state, then:
npm run e2e:fork                # browser test: owners sign + execute via share links, member spends

# same for Gnosis:
FORK_CHAIN=gno npm run fork
FORK_CHAIN=gno npm run test:fork
FORK_CHAIN=gno npm run e2e:fork

# Ethereum, Optimism, Celo the same way; FORK_SAFE=0x… tests another Safe:
FORK_CHAIN=oeth npm run fork
FORK_CHAIN=oeth npm run e2e:fork
```

## Deploying

**Cloudflare Workers (free, recommended):** Cloudflare now creates a Worker when you import a repo. `wrangler.jsonc` and `worker/index.ts` set it up to serve the app and the shared-queue proxy.

1. Workers & Pages, Create, import `tbsoc/safe-ui`. Build command `npm run build`, deploy command `npx wrangler deploy`.
2. The Worker's name must match `"name"` in `wrangler.jsonc` (`safe-ui`). If yours is different, change one of them.
3. After the first deploy, open the Worker's Settings → Variables and Secrets and add `SAFE_API_KEY` (type Secret), or run `npx wrangler secret put SAFE_API_KEY` from this folder. `ALLOWED_SAFES` comes from `wrangler.jsonc`.

Security headers come from `public/_headers`. The app routes with query strings, so no redirect rules are needed.

**Cloudflare Pages** also works: build command `npm run build`, output `dist`, `NODE_VERSION` = `22`, same two settings. Pages uses the `functions/` folder instead of `worker/`.

Vercel and Netlify serve the static app but not the Cloudflare Worker/function, so the shared queue is off there (share links still work).

**Vercel:** New Project, import `tbsoc/safe-ui`. The included `vercel.json` sets everything; no settings to change.

**Netlify:** Add new site, import from Git, pick `tbsoc/safe-ui`. The included `netlify.toml` sets everything.

Every push to `main` then redeploys.

## Security notes

- Always check the decoded calls and the Safe tx hash (under "Details for hardware-wallet verification") before signing.
- Enabling a module lets it move funds by its own rules. The Allowance Module can only move what owners allowed. The Overview flags any unknown module.
- The app never holds keys. All signing happens in your wallet.
