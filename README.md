# Bread Safe

A small, open-source interface for Bread Cooperative's [Safe](https://safe.global) multisigs on **Ethereum, Base and Gnosis**, with full support for the Safe **Allowance Module** (spending limits).

Safe{Wallet} now requires a paid plan to add new spending limits. The limits themselves live in a public smart contract, so this app talks to that contract directly.

- No backend, no accounts, no API keys. It reads the chain through public RPCs.
- Works with Safe contracts v1.3.0 and newer (the Bread Base Safe runs v1.5.0).
- Static site: deploys to Vercel or Netlify as-is.

## What it does

| Tab | What you can do |
| --- | --- |
| Overview | Balances, signers and threshold, nonce, enabled modules |
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

This app uses **Allowance Module v1.0.0** (`0x691f59471Bfd2B7d639DCF74671a2d648ED1E331`, same address on all three chains) for new setups. It fixes a nonce overflow and the handling of tokens that return `false`. If a Safe already has a legacy version enabled (`0.1.0` at `0xCFbF…3134` or `0.1.1` at `0xAA46…091C`), the app detects it and keeps using it.

Limits of the contract worth knowing:

- The longest reset period is 65,535 minutes (about 45.5 days), so monthly works but quarterly does not.
- Periods are fixed intervals, not calendar months. You can align the schedule to a past date.
- Changing an amount does not clear what was already spent this period. Use "Reset spent" for that.
- Members must be regular wallets, or a Safe that calls the module itself. Smart-contract signatures are not accepted.

## How multisig signing works without a backend

1. Someone creates a transaction (Send or Allowances). It is checked against the Safe's own `getTransactionHash` before it is saved.
2. Each owner signs it for free in their wallet (EIP-712). Owners whose wallet cannot sign typed data, or that are themselves Safes, can **Approve on-chain** instead.
3. The transaction and its signatures travel in a **share link** (the part after `#`, which browsers never send to a server). Every owner who opens it merges the signatures into their browser's queue.
4. Once enough owners have confirmed, anyone can **Execute**. If an owner who has not signed executes, their execution counts as a confirmation.

Share links are encoded, not encrypted. Anyone with the link can read the transaction, but nobody can change it without invalidating the signatures.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # outputs dist/
npm test           # unit tests
npm run lint
```

Optional build-time settings (Vercel/Netlify environment variables):

| Variable | Purpose |
| --- | --- |
| `VITE_WC_PROJECT_ID` | Enables WalletConnect (mobile wallets). Free project ID from [Reown](https://cloud.reown.com). Without it, only browser-extension wallets connect. |
| `VITE_RPC_URL_1`, `VITE_RPC_URL_8453`, `VITE_RPC_URL_100` | Replace the default public RPCs for Ethereum, Base, Gnosis. |

### Fork tests

These run the real Bread Base Safe and the real module on a local copy of Base. They add three test keys as extra owners on the fork only.

```bash
npm run fork               # terminal 1: local Base fork on :8545
npm run test:fork          # terminal 2: library-level end-to-end tests
# restart the fork for a clean state, then:
npm run e2e:fork           # browser test: 3 owners sign + execute via share links, member spends
```

## Deploying

**Vercel:** New Project, import `tbsoc/safe-ui`. The included `vercel.json` sets everything; no settings to change.

**Netlify:** Add new site, import from Git, pick `tbsoc/safe-ui`. The included `netlify.toml` sets everything.

Every push to `main` then redeploys.

## Security notes

- Always check the decoded calls and the Safe tx hash (under "Details for hardware-wallet verification") before signing.
- Enabling a module lets it move funds by its own rules. The Allowance Module can only move what owners allowed. The Overview flags any unknown module.
- The app never holds keys. All signing happens in your wallet.
