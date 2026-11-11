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
| Streaming contract (Rust, `contract/`) | Core logic done, 26 unit tests passing; integration tests and testnet deploy next |
| Testnet deployment | Not started |
| Gasless relayer (`relayer/`) | Not started |
| Web app (`web/`) | Not started |
| 1Click cash-out | Not started |
| CSV export | Not started |

## Try it

> Filled in as each part lands. Every step will be "do X → see Y" so a judge can follow it without asking.

### Contract tests

Requirements: Rust 1.95 or newer.

```bash
cd contract
cargo test
```

You should see `26 passed`. The tests cover: funding creates the right streams, rejecting tokens other than USDC, rejecting amounts that do not add up, per-second accrual (including overflow safety), withdrawing to yourself or to another receiver, cancelling (employer refund + worker keeps earned salary), failed-transfer recovery, and fund conservation across a cancel at many points in time.

### Build the contract

Requirements: [cargo-near](https://github.com/near/cargo-near) 0.23 or newer.

```bash
cd contract
cargo near build non-reproducible-wasm
```

You should see `Contract successfully built!` and a `target/near/payday.wasm` of about 185 KB, with its ABI next to it.

## Contract design

A stream records: employer, worker, deposit, amount withdrawn, start and stop time (Unix seconds).

- **Earned** = `deposit × (now − start) / (stop − start)`, rounded down, capped at `deposit` after `stop`.
- **Withdrawable** = earned − withdrawn.
- **Funding**: the employer calls `ft_transfer_call` on the USDC contract with a JSON `msg` listing the streams. The stream amounts must add up to exactly the USDC sent, or the whole transfer is refunded. Only the configured USDC contract is accepted.
- **Withdraw**: `withdraw(stream_id, amount, deposit_address?)`. Without `deposit_address` the USDC goes to the worker; with it, the USDC goes to a 1Click deposit address for cross-chain cash-out.
- **Cancel**: employer or worker. The employer is refunded the unearned part; the worker's earned part stays withdrawable.
- **Failed transfers**: NEAR transfers are asynchronous. If a USDC transfer fails after the contract has updated its books, a callback credits the amount back so nothing is lost. If the stream no longer exists, the amount is credited to an `owed` balance that the account can claim with `claim_owed`.

## Prior work and what is new

Payday's streaming maths and cancel rules are ported from my earlier Solidity project [payment-streams](https://github.com/CharlesChinedum/payment-streams) (ERC-20, Foundry). Everything in this repository was written during NEAR HACKATHON (Nov 2026): the Rust contract, the NEAR-specific async transfer handling, batch funding through `ft_transfer_call`, the gasless relayer, the 1Click cash-out and the web app.

## License

MIT — see [LICENSE](LICENSE).
