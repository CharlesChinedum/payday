# Payday

Payroll in USDC that streams to workers every second. Workers withdraw whenever they like, pay no gas, and can cash out to USDC or USDT on another chain.

**Live demo (NEAR testnet): https://payday-near-eight.vercel.app** — no wallet, no NEAR and no sign-up needed.

Built for NEAR HACKATHON 2026, track **Real-World Money** (`realworld`).

## The problem

A company paying a remote team across borders has three bad options: bank wires that take days and lose money to fees and FX, payroll platforms that do not support the worker's country, or "just send crypto", which forces every worker to buy a gas token before they can touch their own salary.

Workers also wait a whole month to be paid for work they did on day one.

## What Payday does

1. **The employer funds payroll once.** They upload a CSV of workers (account, amount, start date, end date) and send the total in USDC. One transaction creates every salary stream.
2. **Salary accrues every second.** A worker's balance grows in real time between the start and end dates.
3. **Workers withdraw without gas.** A worker signs the withdrawal; the Payday relayer pays the NEAR gas. The worker never needs to own NEAR.
4. **Workers cash out to the chain they use.** Through NEAR Intents (1Click API) a worker can receive USDC on Base, Solana or Arbitrum, or USDT on Tron, in one step.
5. **The employer can stop a stream.** Cancelling refunds everything not yet earned; the worker keeps everything they already earned.
6. **The accountant gets a CSV.** Every payment, with dates, amounts and transaction links.

## How NEAR is used

| NEAR feature | What it does in Payday |
|---|---|
| NEP-141 USDC (Circle, native) | The salary token. Funding uses `ft_transfer_call`, so funding and stream creation are one atomic step. |
| Meta transactions (NEP-366) | Users sign a delegate action in the browser; the Payday relayer submits it and pays the gas. The relayer only sponsors an allowlist of calls (see below). |
| Implicit accounts | Each browser makes its own ed25519 key; its account is the key's hex. Payday creates it once with 0.005 NEAR, so nobody installs a wallet or buys NEAR. |
| NEAR Intents, 1Click API | Cross-chain cash-out from NEAR USDC to USDC/USDT on other chains. |

## Status

This table is kept up to date as the build progresses. Only rows marked **Done** work today.

| Part | Status |
|---|---|
| Streaming contract (Rust, `contract/`) | **Done** — 29 unit tests + 5 sandbox integration tests |
| Mock USDC for testnet (`mock-usdc/`) | **Done** — standard NEP-141, public `mint` (testnet only) |
| Testnet deployment | **Done** — see addresses below |
| Gasless relayer (`web/src/app/api/relay`) | **Done** — allowlisted meta transactions, tested on testnet |
| Web app (`web/`) | **Done** — landing page, employer and worker dashboards; runs locally against testnet |
| 1Click cash-out | **Quotes done** — live mainnet quotes on testnet; real swaps need the mainnet deploy |
| CSV export | **Done** — per-stream accountant export |
| Hosted demo | **Done** — https://payday-near-eight.vercel.app (testnet), checked end to end with `pnpm smoke` |
| Mainnet deployment | Not started |

## Live on testnet

| Contract | Account |
|---|---|
| Payday | [`app.payday-dev.testnet`](https://testnet.nearblocks.io/address/app.payday-dev.testnet) |
| Mock USDC (6 decimals) | [`usdc.payday-dev.testnet`](https://testnet.nearblocks.io/address/usdc.payday-dev.testnet) |

A full run of `scripts/testnet.sh demo` on testnet:

| Step | Transaction |
|---|---|
| Employer funds 1,000 USDC to Alice and 2,000 USDC to Bob in one transfer | [`7MKeDyr1…`](https://testnet.nearblocks.io/txns/7MKeDyr1Av54mGW2vtAzpS8e96dE1yM9CqD94K9SY78t) |
| Alice withdraws her earned salary | [`3pi9Y7vM…`](https://testnet.nearblocks.io/txns/3pi9Y7vMpn372dSUiRY8dfqEJWx8LRcZoNaXgmGzEWey) |
| Employer cancels Bob's stream: refund of the unearned part, Bob keeps what he earned | [`CETJQ4TL…`](https://testnet.nearblocks.io/txns/CETJQ4TLk9jkjS5Rw1cdxeUjSK7YG4Y2Z5mJ3dSxDTXv) |

Afterwards the balances add up to exactly the 3,000 USDC funded: employer refund 1,997.190631 + Alice 1.401987 + held for Alice and Bob 1,001.407382.

The same flow from the web app, every step gas-free for the user (the relayer `relayer.payday-dev.testnet` pays):

| Step | Transaction | Relayer paid |
|---|---|---|
| Employer gets 5,000 test USDC | [`8tjRQudH…`](https://testnet.nearblocks.io/txns/8tjRQudHGCCVzbaGNSCjdZaQ1oRqikGmMJsPZTcsbGim) | 0.00028 NEAR |
| Employer funds a 600 USDC stream from a CSV | [`HSxjnGc7…`](https://testnet.nearblocks.io/txns/HSxjnGc737EY7na2ro79iFRFpBMJ6qhmjaGzQuzAxiKs) | 0.00094 NEAR |
| Worker withdraws earned salary | [`4mwKhaHb…`](https://testnet.nearblocks.io/txns/4mwKhaHbkNEA8tGt35b5K42D9cwJEaLbujZ6pym5HZC6) | 0.00067 NEAR |
| Employer cancels a stream | [`9qYbKwtV…`](https://testnet.nearblocks.io/txns/9qYbKwtVzbtXXuYCMPsZYGbWYsCshNrnCtUdqarm1TgW) | 0.00067 NEAR |

Creating a user's account costs the relayer about 0.012 NEAR once (0.005 NEAR seed plus the account-creation fee).

## Try it

> Every step is "do X → see Y". More steps are added as each part lands.

### 0. Use the hosted demo

Open https://payday-near-eight.vercel.app. Go to **My pay** and copy your account, then to **Run payroll**: click **Get 5,000 test USDC**, **Add my worker account**, **Fund payroll**. Back on **My pay** the balance ticks up and **Withdraw** pays you with no gas. Section 3 below walks through every screen.

To check the deployment without clicking, run the smoke test. It plays both roles with fresh keys through the hosted relayer:

```bash
cd web && pnpm install && pnpm smoke https://payday-near-eight.vercel.app
```

You should see six ✓ lines (two accounts onboarded, mint, fund, withdraw, balance check) with transaction hashes, then `PASS`.

### 1. Run the tests

Requirements: Rust 1.95 or newer and [cargo-near](https://github.com/near/cargo-near) 0.23 or newer.

```bash
scripts/build.sh
cd contract && cargo test
```

You should see `29 passed` (unit) and `5 passed` (integration). The integration tests start a local NEAR sandbox, deploy both contracts and check, with real cross-contract calls:

- funding two streams in one `ft_transfer_call`, and the workers being registered with the token automatically;
- a worker withdrawing and receiving exactly what the stream says;
- a funding transfer whose stream amounts do not add up being refunded in full;
- a different token being refunded in full;
- a withdrawal to an account the token does not know (like a fresh 1Click deposit address) registering it and paying it;
- a cancel splitting the deposit exactly between employer and worker.

### 2. Read the live contract

Requirements: [near CLI](https://github.com/near/near-cli-rs) 0.31 or newer.

```bash
near contract call-function as-read-only app.payday-dev.testnet streams_of json-args '{"account_id":"alice.payday-dev.testnet"}' network-config testnet now
```

You should see Alice's stream with a `withdrawable` amount that grows every time you run it.

### 3. Use the web app

Requirements: Node 20+ and pnpm. You need a funded testnet account for the relayer (create one with `near account create-account sponsor-by-faucet-service`).

```bash
cd web
cp .env.example .env.local   # set RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY
pnpm install
pnpm dev
```

1. Open http://localhost:3000. The payslip in the hero accrues at the salary you set with the slider, and the "Proof" section shows a real stream read from the testnet contract.
2. Open http://localhost:3000/worker (**My pay**). You should see "Your Payday account" with a short id and a **Copy** button.
3. Open http://localhost:3000/employer (**Run payroll**) and click **Get 5,000 test USDC**. The balance counts up to 5,000.00.
4. Under **New payroll**, click **Add my worker account** (or type rows, or drop a `worker,amount,start,end` CSV on the form), then **Fund payroll**. A toast says "Funded 1 worker" with a transaction link, and the stream appears under "Streams you pay".
5. Back on **My pay**, "Available to withdraw" ticks up every frame. Click **Withdraw**: the toast says "You paid no gas", and "In your account" counts up.
6. Under **Cash out to another chain**, pick a destination, paste an address, enter an amount (or **Max**) and click **Get quote**. You get a live NEAR Intents price for that route.
7. On **Run payroll**, **Cancel** asks for confirmation and shows the refund before it acts; **Export CSV** downloads a file with paid out / earned / not yet earned per stream.

`pnpm smoke` with no argument runs the same end-to-end check against http://localhost:3000.

```bash
cd web && pnpm test
```

You should see `26 passed`: the relayer allowlist, signed-delegate decoding (including a byte-identical re-encode, so relayed signatures stay valid), reading results from events, USDC amount parsing, vesting maths that match the contract, the payroll form rows, and the payroll and accountant CSVs.

The animations (salary flow, success tick, empty-state ripple) are original Lottie files generated by `web/scripts/build-lottie.mjs` (`pnpm lottie`) and recoloured from the theme, so they follow light and dark mode. Fonts are bundled from Fontsource (Instrument Serif, Geist, Geist Mono); nothing is fetched from a font CDN.

### 4. Run the flow on your own testnet account

```bash
ROOT=<your-account>.testnet scripts/testnet.sh deploy
ROOT=<your-account>.testnet scripts/testnet.sh demo
```

`deploy` creates `usdc.`, `app.`, `alice.` and `bob.` sub-accounts (about 5.6 testnet NEAR) and deploys both contracts. `demo` mints 3,000 mock USDC, funds two streams, withdraws for Alice, cancels Bob's stream and prints every balance.

## The relayer

`POST /api/relay` takes a base64 signed delegate action, decodes it and sponsors it only if it is exactly one function call matching this allowlist:

| Receiver | Method | Max gas | Deposit | Extra rule |
|---|---|---|---|---|
| Payday | `withdraw` | 50 Tgas | 0 | |
| Payday | `claim_owed` | 30 Tgas | 0 | |
| Payday | `cancel` | 40 Tgas | 0 | |
| USDC | `ft_transfer_call` | 250 Tgas | 1 yoctoNEAR | `receiver_id` must be Payday |
| USDC | `mint` (testnet only) | 30 Tgas | 0 | only to the signer |

Requests are rate-limited per sender and per IP. `POST /api/onboard` creates a browser key's implicit account once; a burst of requests for the same key seeds it once.

A relayed transaction's own status only covers the delegate wrapper, so the app reads success from the contracts' NEP-297 events in every receipt (`stream_created`, `withdrawn`, `stream_canceled`, …) and shows the contract's own error message when a receipt fails.

**Known limits (testnet build):** rate limits and the onboarding memory live in one server process; a multi-instance deployment needs shared storage. On testnet the mock USDC is free to mint, so someone could create many small streams and spend Payday's NEAR on worker registrations; on mainnet each stream costs at least 1 real USDC.

## Contract design

A stream records: employer, worker, deposit, amount withdrawn, start and stop time (Unix seconds).

- **Earned** = `deposit × (now − start) / (stop − start)`, rounded down, capped at `deposit` after `stop`.
- **Withdrawable** = earned − withdrawn.
- **Funding**: the employer calls `ft_transfer_call` on the USDC contract with a JSON `msg` listing the streams. The stream amounts must add up to exactly the USDC sent, or the whole transfer is refunded. Only the configured USDC contract is accepted.
- **Workers need no NEAR**: when a stream is funded, Payday registers the worker with the token contract (NEP-145 `storage_deposit`, 0.00125 NEAR paid by Payday; the token refunds it if the worker is already registered). Funding accepts up to 25 streams per transfer and needs 300 Tgas.
- **Withdraw**: `withdraw(stream_id, amount?, receiver?)`. `amount` defaults to everything withdrawable. Without `receiver` the USDC goes to the worker. With it, Payday first registers the receiver with the token (a fresh 1Click deposit address is not registered with USDC — checked on mainnet), then pays it; withdrawals to another account must be at least 1 USDC so relayed calls cannot cheaply spend Payday's NEAR. Attach 40 Tgas, or 50 with a `receiver`.
- **Cancel**: employer or worker. The employer is refunded the unearned part; the worker's earned part stays withdrawable.
- **Failed transfers**: NEAR transfers are asynchronous. If a USDC transfer fails after the contract has updated its books, a callback credits the amount back so nothing is lost. If the stream no longer exists, the amount is credited to an `owed` balance that the account can claim with `claim_owed`.

## Prior work and what is new

Payday's streaming maths and cancel rules are ported from my earlier Solidity project [payment-streams](https://github.com/CharlesChinedum/payment-streams) (ERC-20, Foundry). Everything in this repository was written during NEAR HACKATHON (Nov 2026): the Rust contract, the testnet mock USDC, the NEAR-specific async transfer handling, automatic worker and receiver registration, batch funding through `ft_transfer_call`, the gasless relayer, the 1Click cash-out and the web app.

Libraries used: near-sdk and near-contract-standards (contracts), near-workspaces (tests), Next.js, React, Tailwind CSS, near-api-js, borsh, lottie-web and Fontsource fonts (web).

AI assistance: the contracts, tests, relayer and web app were built with an AI coding assistant (Claude Code), directed and reviewed by me.

## License

MIT — see [LICENSE](LICENSE).
