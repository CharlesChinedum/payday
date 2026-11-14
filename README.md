# Payday

Payroll in USDC that streams to workers every second. Workers withdraw whenever they like, pay no gas, and can cash out to USDC or USDT on another chain.

**Live demo (NEAR testnet): https://payday-near-eight.vercel.app** — no wallet, no NEAR and no sign-up needed.

Built for NEAR HACKATHON 2026, track **Real-World Money** (`realworld`).

## The problem

A company paying a remote team across borders has three bad options: bank wires that take days and lose money to fees and FX, payroll platforms that do not support the worker's country, or "just send crypto", which forces every worker to buy a gas token before they can touch their own salary.

Workers also wait a whole month to be paid for work they did on day one.

## What Payday does

1. **The employer funds payroll once.** They list workers (account, amount, start date, end date), in the form or as a CSV, and send the total in USDC. One transaction creates every salary stream.
2. **Salary accrues every second.** A worker's balance grows in real time between the start and end dates.
3. **Workers withdraw without gas.** A worker signs the withdrawal; the Payday relayer pays the NEAR gas. The worker never needs to own NEAR.
4. **Workers cash out to the chain they use.** Through NEAR Intents (1Click API) a worker can receive USDC on Base, Solana, Arbitrum or Ethereum, or USDT on Tron, in one step.
5. **The employer can stop a stream.** Cancelling refunds everything not yet earned; the worker keeps everything they already earned.
6. **Money can always leave.** Anyone can send what their Payday account holds to any NEAR account or another chain, and claim anything Payday is holding for them.
7. **The accountant gets a CSV.** Every stream with paid out, earned and not yet earned, in UTC.
8. **Workers get payslips.** A monthly statement for a landlord, bank or visa office, read live from the contract every time its link is opened, so whoever receives it can check it themselves. Print or save it as PDF, or share the link: on X, WhatsApp and Telegram it unfurls into a card with the month and amount, drawn from the chain too (the amount can be left off the card).
9. **Amounts in local currency.** Balances and payslips show an approximate local value (naira, shilling, cedi, rupee, peso and more) next to USDC, at a daily mid-market rate.
10. **DAOs can run payroll too.** A Sputnik DAO pays its contributors the same way: Payday drafts one proposal, the council votes, and the vote that passes it funds every stream, with the DAO as the employer.
11. **Workers can ask to be paid.** A freelancer makes a request link (amount, period, what it is for). It previews as a card when posted, and opens Run payroll with the stream already filled in, so the client only checks and funds it. The link carries no authority: nothing moves until the payer funds it.

## How NEAR is used

| NEAR feature | What it does in Payday |
|---|---|
| NEP-141 USDC (Circle, native) | The salary token. Funding uses `ft_transfer_call`, so funding and stream creation are one atomic step. |
| NEP-145 storage | Payday registers a receiver with USDC only when it is not registered yet, and deducts a one-time 0.01 USDC fee for it. |
| Meta transactions (NEP-366) | Users sign a delegate action in the browser; the Payday relayer verifies it, checks it against chain state, submits it and pays the gas. |
| Implicit accounts | Each browser makes its own ed25519 key from a 12-word recovery phrase; its account is the key's hex. Payday creates the account (1 yoctoNEAR) once it holds USDC or a salary. |
| NEAR Intents, 1Click API | Cross-chain cash-out from NEAR USDC to USDC/USDT on other chains. |
| Sputnik DAO (v2) | DAO payroll: a function-call proposal makes the DAO's USDC `ft_transfer_call` to Payday, so the DAO is the employer of every stream it votes in. Payday reads the DAO's policy, proposals and votes and never signs for it. |

## Fees

| Fee | When | Default |
|---|---|---|
| Stream fee | Per stream, paid by the employer on top of the stream amounts | 0.01 USDC |
| Payout fee | Deducted from every withdrawal, claim and send (not from a cancel refund) | 0.01 USDC |
| Registration fee | Deducted from a payout to an account that has never held USDC (a worker's first withdrawal, a fresh 1Click deposit address) | 0.01 USDC |

Fees pay for what Payday spends on its users' behalf: storage for streams, USDC registrations, and the gas the relayer pays for every gas-free payout. Because each payout pays its own way, nobody can drain the relayer by repeating tiny ones. The owner can change the fees within 0.001 to 1 USDC each, and fees are booked only once the payout they belong to has succeeded.

## Status

| Part | Status |
|---|---|
| Streaming contract 2.1.0 (Rust, `contract/`) | **Done** — 66 unit tests, 9 sandbox integration tests, 7 sandbox security tests; reproducible build checked in CI |
| Mock USDC for testnet (`mock-usdc/`) | **Done** — standard NEP-141, public `mint` (test networks only) |
| Gasless relayer (`web/src/app/api/relay`) | **Done** — signature-verified, pre-flighted against chain state |
| Web app (`web/`) | **Done** — landing page, employer and worker dashboards, backup and restore, move money out |
| 1Click cash-out | **Quotes done** — live mainnet quotes on testnet; real swaps need the mainnet deploy |
| CSV export | **Done** — per-stream accountant export |
| Security review | **Done, three rounds** — see [AUDIT.md](AUDIT.md); every finding fixed or accepted except the deploy-day steps it lists |
| Hosted demo | **Done** — https://payday-near-eight.vercel.app (testnet), redeployed from `main` on every push |
| Mainnet deployment | Not started: the deploy-day steps in AUDIT.md (`scripts/handover.sh`) and a re-review come first |

## Live on testnet

| Contract | Account |
|---|---|
| Payday | [`app.payday-dev.testnet`](https://testnet.nearblocks.io/address/app.payday-dev.testnet) |
| Mock USDC (6 decimals) | [`usdc.payday-dev.testnet`](https://testnet.nearblocks.io/address/usdc.payday-dev.testnet) |
| Demo DAO (Sputnik v2, 2-member council) | [`payday-demo.sputnikv2.testnet`](https://testnet.nearblocks.io/address/payday-demo.sputnikv2.testnet) |

The testnet contract started as version 1.0.0 and was upgraded in place to 2.0.0, keeping every stream (`scripts/testnet.sh migrate-v1`).

## Try it

> Every step is "do X → see Y".

### 0. Use the hosted demo

Open https://payday-near-eight.vercel.app.

1. Go to **My pay** and copy your account id.
2. Go to **Run payroll**, click **Get 5,000 test USDC**, then **Add my worker account** and **Fund payroll**. The toast says "Funded 1 worker".
3. Back on **My pay**, the balance ticks up. Click **Withdraw** (from 1 USDC): Payday keeps a 0.01 USDC payout fee, plus 0.01 USDC the first time to set up your account, and you pay no gas.
4. Under **Back up this account**, reveal and save your recovery phrase.
5. Under **Payslips**, pick a month and click **Open payslip**: a printable statement of what you earned, by employer and stream, with the contract call that proves each line. Use **Show in** to see amounts in your local currency. Under **Share this payslip**, the card shown is what the link looks like when posted; tick **Leave the amount out of the preview** to share it without the figure, then **Post on X**, **WhatsApp** or **Telegram**.
6. Under **Request payment**, enter an amount, a period and what it is for, then **Make link**. Open the link: Run payroll shows who is asking and has the stream filled in from today, ready to fund.

To check a deployment without clicking, run the smoke test. It plays both roles with fresh keys, then replays the attacks from the security review and checks each is refused:

```bash
cd web && pnpm install && pnpm smoke https://payday-near-eight.vercel.app
```

You should see ✓ lines for the faucet, both accounts, funding, a withdrawal, a send, and eleven refused attacks, then `PASS`.

### 0b. Pay from a DAO

Open https://payday-near-eight.vercel.app/dao?dao=payday-demo.sputnikv2.testnet. This demo DAO pays two contributors through Payday: proposal 0 was drafted on this page, submitted ([`28cPowAF…`](https://testnet.nearblocks.io/txns/28cPowAFVD3HNkMN3BCv7fR3eJG3rQ6Cv1PJdfXgZd8R)) and passed by both council members; the passing vote ([`HUCZYyax…`](https://testnet.nearblocks.io/txns/HUCZYyaxNbrh1eSmSKaXfzfLC3rAC18LnJk3uWg5pzo8)) moved 1,000.02 USDC from the DAO to Payday and opened streams #10 and #11 with the DAO as employer. Any other testnet Sputnik DAO works the same way.

1. You see the DAO's USDC, the salaries it pays, who votes and the vote threshold.
2. Add contributors and click **Draft proposal**. You get a ready-to-run NEAR CLI command that submits it with the DAO's bond.
3. Once a council member submits it, it appears under **Payday proposals** with its votes, and a vote command for the others. The proposal's effect is read from its arguments, not its description.
4. The vote that passes it funds the streams; they appear under **Salaries this DAO pays**, where **Propose stop** drafts a cancel.

### 1. Run the tests

Requirements: Rust 1.95 or newer, [cargo-near](https://github.com/near/cargo-near) 0.23 or newer, Node 24 and pnpm.

```bash
scripts/build.sh
cd contract && cargo test
```

You should see `66 passed` (unit), `9 passed` (integration) and `7 passed` (security). The sandbox tests deploy both contracts to a local NEAR node and check, with real cross-contract calls: funding with fees, payouts that carry the payout fee and register new receivers (charging registration only then), failed payouts restored to their stream with no fee kept, that the contract's USDC balance always equals what it owes, cancels that split funds exactly, sending USDC out through Payday, the owner upgrading the contract through itself, and that the attacks from [AUDIT.md](AUDIT.md) no longer work.

```bash
cd web && pnpm test
```

You should see `92 passed`: browser keys that cannot be read out (and still sign what the relayer accepts, migrate, restore), the shared rate limits and relay lock, the page CSP, the relayer policy and pre-flight, payslip periods and earnings (split across months by the contract's vesting rule) and their share cards, request-to-be-paid links, exchange-rate validation, IPv6 rate-limit keys, DAO proposals (built, read back from their arguments, and safely quoted in CLI commands), signature verification (including the audit's forged delegate), delegate decoding, reading results from events, address checksums, recovery phrases, amount and date parsing, vesting maths and the CSVs.

### 2. Run everything locally

No testnet account needed. Runs a NEAR sandbox node, deploys both contracts, and runs the app against it on port 3001.

```bash
cd web
pnpm localnet          # terminal 1: the node, RPC on 127.0.0.1:3030
pnpm localnet:setup    # deploys contracts, creates a relayer, writes .env.localnet
pnpm dev:localnet      # terminal 2: the app on http://localhost:3001
set -a; source .env.localnet; set +a; node scripts/smoke.mjs http://localhost:3001
```

The smoke test should end in `PASS  http://localhost:3001 (localnet)`.

### 3. Run the web app against testnet

You need a funded testnet account for the relayer (`near account create-account sponsor-by-faucet-service`).

```bash
cd web
cp .env.example .env.local   # set RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY
pnpm install
pnpm dev
```

Then follow section 0 on http://localhost:3000. **Export CSV** on Run payroll downloads paid out / earned / not yet earned per stream.

### 4. Deploy your own contracts on testnet

```bash
ROOT=<your-account>.testnet scripts/testnet.sh deploy
ROOT=<your-account>.testnet scripts/testnet.sh upgrade   # later, through the contract's owner
```

`deploy` creates `usdc.` and `app.` sub-accounts (about 6 testnet NEAR), deploys both contracts and makes `ROOT` the owner.

## The relayer

`POST /api/relay` takes a base64 signed delegate action and pays for it only if every check passes, in this order:

1. **Policy.** Exactly one function call from this table, with strictly shaped arguments:

   | Receiver | Method | Gas (exact) | Deposit | Rule |
   |---|---|---|---|---|
   | Payday | `withdraw` | 100 Tgas | 0 | |
   | Payday | `claim_owed` | 100 Tgas | 0 | |
   | Payday | `cancel` | 100 Tgas | 0 | |
   | USDC | `ft_transfer_call` | 150 Tgas | 1 yoctoNEAR | to Payday, with `{"streams": [...]}` or `{"send_to": "..."}` |

2. **Signature.** The sender must be the implicit account of the signing ed25519 key, and the signature must cover this exact delegate.
3. **Pre-flight.** Against chain state: the key exists, the nonce is fresh and in range, the delegate is neither expired nor valid for more than about ten minutes, and the call will succeed and is worth paying for (the stream exists, is live and the sender may act on it; withdrawals are at least 1 USDC or empty the stream; every payout covers its fees; nobody sends to themselves or to Payday or the token; new streams are within the contract's bounds; the balance covers the transfer).
4. **Budget.** Per-IP limits (IPv6 by /64), per-sender limits with one request in flight at a time, and a relayer balance floor read from the chain that stops all spending below 0.5 NEAR.

`GET /api/og/request` draws a request link's card from the link alone (cached for a day). `GET /api/og/payslip` draws a payslip link's preview card (1200×630 PNG) from the contract, cached at the edge for ten minutes for the current month and a day for past ones; a bad link gets the plain Payday card. `GET /api/rates` serves USD exchange rates for the offered currencies from [ExchangeRate-API](https://www.exchangerate-api.com)'s open endpoint, fetched at most every six hours, validated, and cached at the edge, so browsers never contact a third party. `POST /api/onboard` creates a browser key's account (1 yoctoNEAR) only if it holds USDC, has a stream or is owed money. `POST /api/faucet` mints test USDC on test networks. `POST /api/quote` validates the destination address per chain, requires a Payday refund account that can afford the amount (and, on mainnet, can receive a refund), and checks that 1Click's answer is for exactly what was asked and plausible.

All API routes accept only same-origin `application/json` requests with small bodies, and answer errors generically with a reference id.

A relayed transaction's own status only covers the delegate wrapper, so the app reads success from the contracts' NEP-297 events, counting only events from the contract that owns their standard.

**Rate limits** are shared by every server instance through Upstash Redis (set `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or the `UPSTASH_REDIS_REST_*` pair, as the Vercel Marketplace integration does); without them each instance limits on its own, and the relayer's balance floor is the global stop.

**Keys and scripts:** each browser account's key is a non-extractable WebCrypto Ed25519 key in IndexedDB, so no script or extension can read it out, and its recovery phrase is deleted from the browser once the user confirms the backup. Every page is rendered per request with a nonce Content Security Policy (`web/src/proxy.ts`), so injected inline scripts do not run.

**Known limits:** Payslips cover streams the contract still holds: a stream that ended and was fully withdrawn is deleted (to keep storage paid for) and drops off them; an indexer would bring that history back. On test networks the mock USDC is free, so the stream fee there is not a real cost.

## Contract design

A stream records: employer, worker, deposit, amount withdrawn, start and stop time (Unix seconds).

- **Earned** = `deposit × (now − start) / (stop − start)`, rounded down, capped at `deposit` after `stop`. **Withdrawable** = earned − withdrawn.
- **Funding**: `ft_transfer_call` on USDC with `msg` `{"streams": [...]}` (up to 25). The amount sent must equal the stream amounts plus the stream fees, or the whole transfer is refunded. Only the configured USDC contract is accepted. Starts must be within a year of now and streams at most five years long.
- **Payouts** (withdraw, claim, cancel refunds, sends) all go the same way: ask USDC whether the receiver is registered; if not, register it and add the registration fee; transfer the amount less the fees; then settle in a callback, which books the fees only on success. A payout that fails is put back in full where it came from (the stream, or the account's `owed` balance).
- **Withdraw**: `withdraw(stream_id, amount?, receiver?)`. At least 1 USDC, or everything left in the stream, and more than the fees. Attach 100 Tgas.
- **Cancel**: employer or worker. The employer is refunded the unearned part. The worker's earned part stays in the stream, or, below 1 USDC, moves to their `owed` balance so the stream can be deleted.
- **Send**: `ft_transfer_call` to Payday with `msg` `{"send_to": "account"}` passes USDC on, registering the receiver if needed. This is how browser accounts move money out.
- **Storage**: streams are deleted once fully paid out; `prune(stream_ids)` lets anyone delete settled ones; `streams_of(account, from_index, limit)` pages. Funding is refused, and registrations are skipped, if they would eat into a NEAR reserve kept for callbacks.
- **Owner**: sets fees (0.001 to 1 USDC each), pauses new funding, withdraws collected fees, and upgrades the contract through `upgrade` (new code, then `migrate`), so the contract account can drop its own keys. Ownership moves in two steps. On mainnet the owner is a Sputnik DAO and the contract account has no keys: `scripts/handover.sh` prints the steps, and upgrades are a DAO `store_blob` plus an `UpgradeRemote` vote. Anyone can rebuild a deployed commit with `cargo near build reproducible-wasm` (image pinned in `contract/Cargo.toml`) and compare `scripts/code_hash.py contract/target/near/payday.wasm` with the account's `code_hash`.
- **Registrations**: Payday pays for an account's USDC registration at most once. Circle USDC refunds the deposit to an account that unregisters, so paying again would let it farm the deposit (AUDIT I-07).

## Prior work and what is new

Payday's streaming maths and cancel rules are ported from my earlier Solidity project [payment-streams](https://github.com/CharlesChinedum/payment-streams) (ERC-20, Foundry). Everything in this repository was written during NEAR HACKATHON (Nov 2026): the Rust contract, the testnet mock USDC, the NEAR-specific async payout handling, registration and fees, batch funding and sends through `ft_transfer_call`, the gasless relayer and its verification, the 1Click cash-out, the security review and its fixes, and the web app.

Libraries used: near-sdk and near-contract-standards (contracts), near-workspaces (tests), Next.js, React, Tailwind CSS, near-api-js, borsh, @scure/base, @noble/hashes, bip39-light, lottie-web and Fontsource fonts (web).

AI assistance: the contracts, tests, relayer and web app were built with an AI coding assistant (Claude Code), directed and reviewed by me.

## License

MIT — see [LICENSE](LICENSE).
