# Payday

Payroll in USDC that streams to workers every second. Workers withdraw whenever they like, pay no gas, and can cash out to USDC or USDT on another chain.

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
| Meta transactions (NEP-366) | Workers sign; the relayer submits and pays gas. The relayer only accepts calls to the Payday contract. |
| NEAR Intents, 1Click API | Cross-chain cash-out from NEAR USDC to USDC/USDT on other chains. |

## Status

This table is kept up to date as the build progresses. Only rows marked **Done** work today.

| Part | Status |
|---|---|
| Streaming contract (Rust, `contract/`) | **Done** — 27 unit tests + 5 sandbox integration tests |
| Mock USDC for testnet (`mock-usdc/`) | **Done** — standard NEP-141, public `mint` (testnet only) |
| Testnet deployment | **Done** — see addresses below |
| Gasless relayer (`relayer/`) | Not started |
| Web app (`web/`) | Not started |
| 1Click cash-out | Not started |
| CSV export | Not started |

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

## Try it

> Every step is "do X → see Y". More steps are added as each part lands.

### 1. Run the tests

Requirements: Rust 1.95 or newer and [cargo-near](https://github.com/near/cargo-near) 0.23 or newer.

```bash
scripts/build.sh
cd contract && cargo test
```

You should see `27 passed` (unit) and `5 passed` (integration). The integration tests start a local NEAR sandbox, deploy both contracts and check, with real cross-contract calls:

- funding two streams in one `ft_transfer_call`, and the workers being registered with the token automatically;
- a worker withdrawing and receiving exactly what the stream says;
- a funding transfer whose stream amounts do not add up being refunded in full;
- a different token being refunded in full;
- a withdrawal to an account the token does not know failing and being credited back, after which a normal withdrawal works;
- a cancel splitting the deposit exactly between employer and worker.

### 2. Read the live contract

Requirements: [near CLI](https://github.com/near/near-cli-rs) 0.31 or newer.

```bash
near contract call-function as-read-only app.payday-dev.testnet streams_of json-args '{"account_id":"alice.payday-dev.testnet"}' network-config testnet now
```

You should see Alice's stream with a `withdrawable` amount that grows every time you run it.

### 3. Run the flow on your own testnet account

```bash
ROOT=<your-account>.testnet scripts/testnet.sh deploy
ROOT=<your-account>.testnet scripts/testnet.sh demo
```

`deploy` creates `usdc.`, `app.`, `alice.` and `bob.` sub-accounts (about 5.6 testnet NEAR) and deploys both contracts. `demo` mints 3,000 mock USDC, funds two streams, withdraws for Alice, cancels Bob's stream and prints every balance.

## Contract design

A stream records: employer, worker, deposit, amount withdrawn, start and stop time (Unix seconds).

- **Earned** = `deposit × (now − start) / (stop − start)`, rounded down, capped at `deposit` after `stop`.
- **Withdrawable** = earned − withdrawn.
- **Funding**: the employer calls `ft_transfer_call` on the USDC contract with a JSON `msg` listing the streams. The stream amounts must add up to exactly the USDC sent, or the whole transfer is refunded. Only the configured USDC contract is accepted.
- **Workers need no NEAR**: when a stream is funded, Payday registers the worker with the token contract (NEP-145 `storage_deposit`, 0.00125 NEAR paid by Payday; the token refunds it if the worker is already registered). Funding accepts up to 25 streams per transfer and needs 300 Tgas.
- **Withdraw**: `withdraw(stream_id, amount?, receiver?)`. `amount` defaults to everything withdrawable. Without `receiver` the USDC goes to the worker; with it, the USDC goes to that account, e.g. a 1Click deposit address for cross-chain cash-out. Needs about 25 Tgas; attach 40.
- **Cancel**: employer or worker. The employer is refunded the unearned part; the worker's earned part stays withdrawable.
- **Failed transfers**: NEAR transfers are asynchronous. If a USDC transfer fails after the contract has updated its books, a callback credits the amount back so nothing is lost. If the stream no longer exists, the amount is credited to an `owed` balance that the account can claim with `claim_owed`.

## Prior work and what is new

Payday's streaming maths and cancel rules are ported from my earlier Solidity project [payment-streams](https://github.com/CharlesChinedum/payment-streams) (ERC-20, Foundry). Everything in this repository was written during NEAR HACKATHON (Nov 2026): the Rust contract, the testnet mock USDC, the NEAR-specific async transfer handling, automatic worker registration, batch funding through `ft_transfer_call`, the gasless relayer, the 1Click cash-out and the web app.

## License

MIT — see [LICENSE](LICENSE).
