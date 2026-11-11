# Payday security review

| | |
|---|---|
| Date | 11 November 2026 |
| Commit reviewed | `7d1dc4a` |
| Scope | `contract/` (Payday, Rust, near-sdk 5.30), `web/src/app/api/*` (relayer, onboarding, quote proxy), `web/src/lib` and the client code that signs and decides success, `scripts/` |
| Out of scope | `mock-usdc/` beyond how it differs from Circle USDC; Vercel dashboard settings; NEAR Intents 1Click itself |
| Method | Line-by-line review by the author's assistant plus two independent read-only reviewers (one contract, one server/client); 6 sandbox proof-of-concept tests (`contract/tests/audit_poc.rs`); targeted checks against NEAR testnet and read-only checks against mainnet USDC |

## Verdict

**No path was found to steal USDC or to make the contract's books disagree with the tokens it holds.** Every transfer is debited before it is sent and reconciled in a callback, and the reviewers traced every race between `withdraw`, `cancel`, `claim_owed` and their callbacks without finding a way to create or lose value.

**Payday is not ready for mainnet.** Anonymous callers can spend the NEAR that pays for everything: the relayer's (confirmed on testnet with a forged request) and the contract's (confirmed in the sandbox). Users' keys sit in browser storage with no backup and no way to move money out. The contract account is one hot key with no upgrade or migration path.

**The live testnet demo is exposed now.** The relayer holds 1.83 testnet NEAR. One IP sending forged requests at the allowed rate empties it in about six hours; a handful of IPs, or the cross-origin trick in M-09, in under an hour. That would take the demo down before judging ends on 18 November. H-01, H-02 and H-04 are worth fixing before then, testnet or not.

## Summary

| ID | Finding | Severity | Status |
|---|---|---|---|
| H-01 | Relayer pays for delegate actions it never verifies | High | Confirmed on testnet |
| H-02 | `/api/onboard` hands out spendable NEAR | High | Confirmed (balance check), not executed |
| H-03 | Anyone can spend the contract's NEAR at no USDC cost | High | Confirmed in sandbox (PoC F-01, F-04) |
| H-04 | Rate limits live in one server's memory; no spend ceiling | High | Confirmed by reading |
| H-05 | User keys: plaintext in `localStorage`, no backup or export | High on mainnet | Confirmed by reading |
| H-06 | No in-app way to move USDC out of a browser account | High on mainnet | Confirmed by reading |
| M-01 | Settled streams are never deleted | Medium | Confirmed in sandbox (PoC F-02) |
| M-02 | Anyone can fill a victim's stream list; `streams_of` is unpaginated | Medium | Confirmed in sandbox (PoC F-03) |
| M-03 | One full-access key controls the contract; no migration, pause or multisig | Medium | Confirmed on testnet |
| M-04 | Cash-out trusts the quote response and never expires it | Medium | Confirmed by reading |
| M-05 | Quote endpoints are an open proxy carrying the 1Click JWT | Medium | Confirmed by reading |
| M-06 | Uncapped public key decode pins a server for seconds | Medium | Measured by reviewer |
| M-07 | Sender rate limit is counted before the sender is proven; limiter memory unbounded | Medium | Confirmed by reading |
| M-08 | `accountExists` fails open, so RPC errors re-seed accounts | Medium | Confirmed by reading |
| M-09 | Cross-origin "simple" POSTs are accepted | Medium | Confirmed by reading |
| L-01 | A timeout is reported as "failed" even if the transaction landed | Low | Confirmed by reading |
| L-02 | Commas in amounts shift payroll columns; dates parse in local time | Low | Confirmed locally |
| L-03 | A failed-transfer credit can be lost when the contract has no spare NEAR | Low | Plausible, not tested |
| L-04 | A worker who ends up unregistered with USDC cannot fix it without NEAR | Low | Confirmed by reading |
| L-05 | `new` can be called by anyone until state exists | Low | Confirmed by reading |
| L-06 | Raw library and RPC errors are returned to anonymous callers | Low | Confirmed by reading |
| I-01…I-09 | Hardening notes | Informational | |

---

## High

### H-01. Relayer pays for delegate actions it never verifies

**Where:** `web/src/app/api/relay/route.ts`, `web/src/lib/policy.ts`, `web/src/lib/delegate.ts`

The relay route checks only the receiver, method, gas, deposit and one argument. It never checks the signature, that the public key belongs to the sender, the nonce, `maxBlockHeight`, or that the sender exists. NEAR validates those when the delegate receipt executes, after the relayer has paid for the transaction.

**Confirmed on testnet:** a delegate from a random, non-existent sender with a signature of 64 zero bytes was accepted by `https://payday-near-eight.vercel.app/api/relay`, submitted as transaction `GPwZNAyRbhnSncyA9jE75azu4gwroxAReJQooNUhtzXV`, failed on chain, and cost the relayer **0.000082 NEAR**.

- The attacker needs no account, key or funds.
- The per-sender limit is keyed on the attacker-chosen sender, so only the per-IP limit applies: 60 per minute per server instance, about 7 NEAR a day per IP.
- Replays of real, already-used delegates are also paid for.

**Fix, in this order, before any rate-limit counter is touched:**
1. Cap the request body (a few KB) and argument size.
2. Require the sender to be a 64-hex implicit account equal to the hex of the delegate's ed25519 public key.
3. Verify the ed25519 signature over the NEP-366 delegate hash.
4. Read the access key: it must exist, the nonce must be greater than the key's nonce, and `maxBlockHeight` must be within about 200 blocks of the head.
5. Pre-flight with view calls: `withdraw` only if the sender is the stream's worker and something is withdrawable; `cancel` only for a party to the stream; `claim_owed` only if `owed_of > 0`; `ft_transfer_call` only if the balance covers it and `msg` parses with 1 to 25 streams.

### H-02. `/api/onboard` hands out spendable NEAR

**Where:** `web/src/app/api/onboard/route.ts`

Each request sends 0.005 NEAR to the implicit account of a public key the caller supplies. The caller holds the private key.

**Confirmed:** the employer account created during testing still holds exactly 5,000,000,000,000,000,000,000 yoctoNEAR (0.005) after three relayed `ft_transfer_call`s that each carried a 1 yoctoNEAR deposit. So the relayer, not the user, pays those deposits, and none of the seed is needed for them. The account uses 182 bytes, under NEAR's 770-byte free-storage allowance for small accounts, so the whole 0.005 NEAR can be transferred out. The transfer itself was not executed.

- Each onboarding costs the relayer about **0.0121 NEAR**: the 0.005 seed plus a 0.0071 account-creation fee (relayer transaction history).
- Deleting the account makes the same key eligible again.
- The only brake is 5 per hour per IP, held in memory (H-04).

**Fix:** seed the minimum that creates the account (try 1 yoctoNEAR on testnet), and onboard only accounts that have something on-chain to protect: an employer once `ft_balance_of` is at least 1 USDC, a worker once `streams_of` is non-empty. Add a global daily onboarding budget.

### H-03. Anyone can spend the contract's NEAR at no USDC cost

**Where:** `contract/src/lib.rs` lines 213–215 (registration at funding), 257–262 (registration on withdraw to another account), 33–40

The contract attaches 0.00125 NEAR of its own balance to register each new worker and each external receiver with the token. The only deterrent is the 1 USDC minimum, and that USDC is fully recoverable.

**Confirmed in the sandbox:**
- **F-01:** funding 25 one-USDC streams that have not started, then cancelling them, cost the attacker **0 USDC** and the contract **0.03125 NEAR**. Repeatable with the same 25 USDC.
- **F-04:** ten 1 USDC cash-outs to fresh accounts cost the contract **0.0125 NEAR**, while the worker kept every unit of USDC.

With H-01 and H-02 every one of those calls is gas-free for the attacker. When the contract's spare NEAR is gone, funding fails (it attaches a deposit for every worker) and every cash-out fails.

**Possibly profitable (not verified for Circle USDC):** in the NEAR standard token, `storage_unregister` refunds the registration deposit to the account itself, which would let the attacker collect the 0.00125 NEAR the contract paid and reuse the account. Check whether Circle's contract behaves the same before mainnet.

**Fix:**
- Make the caller pay. Either an employer-funded NEAR storage balance on Payday, debited per stream and per registration and credited back when a stream is deleted, or a non-refundable USDC fee per stream and per external withdrawal priced above the NEAR cost.
- Call `storage_balance_of` first and register only when needed.
- Keep a NEAR reserve, and skip registration rather than panic when below it, so a drain cannot block payroll.

### H-04. Rate limits live in one server's memory; no spend ceiling

**Where:** `web/src/lib/server/relayer.ts` (`rateLimiter`), `web/src/app/api/onboard/route.ts` (`recentlySeeded`)

On Vercel each instance has its own counters, they reset on every deploy and cold start, and load spawns new instances with fresh limits. There is no global budget, no low-balance cut-off and no alerting. The README already lists this as a known limit.

**Fix:** move counters and the seeded set to a shared atomic store, or use Vercel Firewall rate-limit rules. Limit per verified account, per IP and globally (a daily NEAR budget per endpoint). Refuse to relay below a balance floor. Keep a small float in the relayer and top it up from a cold account.

### H-05. User keys are plaintext in `localStorage`, with no backup or export

**Where:** `web/src/lib/near.ts` (`loadKeyPair`), `web/src/lib/hooks.ts`

- **Theft:** any XSS, malicious dependency, browser extension or compromised deploy reads every key. Auto-deploy from `main` means a compromised GitHub account ships key-stealing code to every user. With a worker key the thief withdraws vested salary to themselves as it vests, and can swap the account's keys. With an employer key they cancel every stream and move all USDC. There is no Content-Security-Policy (I-01).
- **Loss:** clearing site data, another browser or device, private browsing, or a different domain (including each Vercel preview URL) means a new key. A worker loses vested, unwithdrawn salary; an employer loses the account's USDC and the ability to cancel.
- **Two tabs on first visit** each create a key; the second overwrites the first while the first tab still shows its account id.

No XSS sink was found in the current code, so theft needs one of the vectors above.

**Fix before real money:** an explicit backup or export shown before an account id can be shared, plus import. Prefer a real wallet or passkey signer on mainnet; at minimum a non-extractable WebCrypto key in IndexedDB. Create the key under a Web Lock. Serve production from one stable domain.

### H-06. No in-app way to move USDC out of a browser account

**Where:** `web/src/lib/policy.ts` (only `ft_transfer_call` to Payday is sponsored), `web/src/components/worker/*`, `web/src/components/employer/EmployerView.tsx`

- **Withdraw** sends salary to the worker's browser account; **Cash out** draws only from streams, never from that balance. A failed 1Click swap also refunds to that account.
- An employer's cancel refunds and leftover balance have no send function.
- `claim_owed` is sponsored but no screen calls it, and the cancel message says "Unearned salary is back in your balance" even when the refund failed and went to `owed`.

The only exit today is copying the key out of devtools into a wallet.

**Fix:** let cash-out draw from the account balance under strict relayer rules, add a "Claim" action for `owed`, report `transfer_failed` honestly, and decide how employers bring USDC in and take it out on mainnet.

---

## Medium

### M-01. Settled streams are never deleted

**Where:** `contract/src/lib.rs` `withdraw` / `on_withdraw` (no removal), `cancel` (refuses once `now >= stop`)

**Confirmed (F-02):** 25 finished, fully withdrawn streams left **5,359 bytes** (214 bytes, 0.00214 NEAR, each) in the contract for good, after the attacker recovered all 25 USDC. No attacker is needed: an employer paying 100 people monthly adds 1,200 dead records a year.

**Fix:** in `on_withdraw`, delete the stream once `withdrawn == deposit` and `now >= stop`; apply the same rule at cancel; add a permissionless `prune(stream_ids)`.

### M-02. Anyone can fill a victim's stream list; `streams_of` is unpaginated

**Where:** `by_account` (`LookupMap<AccountId, Vec<u64>>`), `index_add`, `streams_of`

**Confirmed (F-03):** a stream cancelled a moment after it started cost the attacker **2 base units** of USDC and stays in the victim's list permanently, since `cancel` is closed once it has ended. With 503 entries, `streams_of` returned 93 KB of JSON in one call. The reviewer measured about 0.07 Tgas per entry on the mock VM, which crosses the view gas limit at roughly 4,000 entries. Funding the victim barely slows down (0.001 Tgas per entry), so this is a denial of the dashboard and discovery, not of payment.

**Fix:** M-01's pruning, plus `streams_of(account, from_index, limit)`. Consider sending a sub-minimum cancel remainder to `owed` and deleting the stream.

### M-03. One full-access key controls the contract; no migration, pause or multisig

**Where:** deployment (`scripts/testnet.sh`), contract state layout

**Confirmed on testnet:** `app.payday-dev.testnet` has a single full-access key, stored in `~/.near-credentials/testnet/` with mode `644` (readable by any local user). Whoever holds it can deploy code that transfers out every stream's USDC. The state structs are unversioned and `upgrade` redeploys without a migration, so any layout change bricks the contract until a migration lands, and callbacks that fail in that window drop credits (L-03).

**Fix:** hold the mainnet account under a multisig or DAO with a timelock; version the state and add a `#[private] #[init(ignore_state)] migrate`; add a pause that blocks new funding only; publish a reproducible build (`cargo near build reproducible-wasm`).

### M-04. Cash-out trusts the quote response and never expires it

**Where:** `web/src/components/worker/CashOut.tsx`, `web/src/app/api/quote/route.ts`

The quote's `depositAddress` and `amountIn` go straight into `withdraw` with no format check, and the amount withdrawn is the quote's, not what the user typed. The offer has no deadline in the UI although the server requested a 30-minute one. The deposit address lives only in React state, so a reload after sending loses tracking. The recipient is validated only in the browser and without checksums; `refundTo` is not validated.

**Fix:** validate recipient per chain (EIP-55, Solana length, Tron checksum) and `refundTo` and `depositAddress` as 64-hex on the server; check the echoed request matches; return and enforce the deadline; persist `{depositAddress, txHash}` before sending.

### M-05. Quote endpoints are an open proxy carrying the 1Click JWT

**Where:** `web/src/app/api/quote/route.ts`

No authentication and no rate limit on either verb. On mainnet every POST mints a real deposit address under Payday's partner credential, for any amount and recipient. No `fetch` timeout, and a `null` JSON body throws a 500 (the relay route has the same crash).

**Fix:** rate-limit both verbs; require a signed message from an account with a stream and bind `refundTo` to it; cap the amount at the withdrawable balance; add timeouts and error handling; restrict the status lookup to 64-hex addresses.

### M-06. Uncapped public key decode pins a server for seconds

**Where:** `web/src/app/api/onboard/route.ts`, `implicitAccountId`

`publicKey` is only checked to be a string before base58 decoding, which is quadratic. The reviewer measured 0.57 s for 20,000 characters and 2.4 s for 40,000; larger bodies run to the function timeout. This happens before any rate limit.

**Fix:** reject anything not matching `^(ed25519:)?[1-9A-HJ-NP-Za-km-z]{43,44}$` before decoding; cap body size on all three routes.

### M-07. Sender rate limit counted before the sender is proven; limiter memory unbounded

**Where:** `web/src/app/api/relay/route.ts`, `rateLimiter`

Twenty forged requests a minute naming a victim's account use up that victim's quota, so their real withdrawals get 429. The limiter map never evicts, and every new sender name adds an entry even when the IP limit rejects it, so memory grows until the instance dies, which also resets every counter.

**Fix:** check IP first, count a sender only after signature verification (H-01), cap key length, evict expired entries.

### M-08. `accountExists` fails open

**Where:** `web/src/lib/server/relayer.ts`

Any RPC error is read as "account does not exist", so during an RPC outage or rate limit existing users are seeded again on every visit. Anyone can make the server hammer the free public RPC through `/api/onboard` before any rate limit.

**Fix:** return false only for the typed "does not exist" error and answer 503 otherwise; use an authenticated RPC with a fallback; rate-limit before the lookup.

### M-09. Cross-origin "simple" POSTs are accepted

**Where:** all three routes

`req.json()` parses any `Content-Type`, and no `Origin` check exists. Any website can make its visitors' browsers POST attacker-chosen keys to `/api/onboard` as `text/plain`, with no preflight, giving every visitor IP its own allowance. User keys are not exposed: other origins cannot read Payday's storage and there are no cookies.

**Fix:** require `Content-Type: application/json` and a same-origin `Origin` / `Sec-Fetch-Site`.

---

## Low

**L-01. A timeout is reported as "failed" even if the transaction landed.** The relay route waits for execution; a slow RPC can push it past the function limit, and the client shows "Funding failed" and keeps the form while the payroll was funded. A natural retry funds it twice. Cash-out discards the deposit address the same way. *Fix:* report "unknown", re-read chain state before allowing a retry; longer term, return the hash immediately and poll.

**L-02. Commas in amounts shift payroll columns; dates parse in local time.** The payroll form joins its fields into CSV without escaping, so an amount of `1,000` with a start date becomes 1 USDC starting 1 January 2000 (`Date.parse("000")` gives `1999-12-31T23:00Z` in Lagos time) and almost fully vested at creation. Cash-out strips commas, so `12,50` reads as 1,250. `12/01/2026` parses as 1 December, US order. *Fix:* validate form rows as structured fields, reject commas in amounts, accept only strict `YYYY-MM-DD` or ISO-8601 with `Z`.

**L-03. A failed-transfer credit can be lost when the contract has no spare NEAR.** If H-03 has drained the contract to its storage stake and a refund then fails, the callback cannot pay for a new `owed` entry and the credit is dropped; the USDC stays in the contract, owed to nobody. *Fix:* H-03's reserve; optionally a governed sweep of provable surplus. *Not tested.*

**L-04. A worker who ends up unregistered with USDC cannot fix it without NEAR.** Registration at funding is fire-and-forget; if it fails, or the worker later unregisters, their own withdrawals fail (safely credited back) and the relayer does not sponsor `storage_deposit`. *Fix:* register before transfer whenever a receiver is given, including the worker, under H-03's charging rules.

**L-05. `new` can be called by anyone until state exists.** Safe in `testnet.sh`, which deploys and initialises in one transaction; risky in a manual two-step mainnet deploy. *Fix:* `#[private]` on `new`, and always deploy with the init call.

**L-06. Raw errors reach anonymous callers.** near-api-js and RPC messages can reveal relayer nonce, balance and configuration state ("RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY must be set"). The private key itself never appears. *Fix:* generic messages with a correlation id; log details server-side.

## Informational

- **I-01. No security headers.** Add a nonce-based CSP (`connect-src` limited to the app and RPC hosts), `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- **I-02. Wrong comments about who pays deposits.** `near.ts` and `onboard/route.ts` say the signer pays attached deposits; the relayer does (confirmed, H-02). The exact deposit pin in `policy.ts` is therefore load-bearing: any rule that allows a non-zero deposit would let users spend the relayer's NEAR. Fix the comments and add a test.
- **I-03. Bind events to their emitter.** `outcome.ts` accepts a `payday` event from any receipt; filter by executor. No spoof is possible in today's flows.
- **I-04. Validate config at boot.** An unset `NEXT_PUBLIC_PAYDAY_MAINNET` becomes `""`; an unset network silently means testnet; it is missing from `.env.example`.
- **I-05. Contract input bounds.** `start` may be 0 and `stop` up to `u64::MAX`, so a milliseconds-for-seconds mistake passes; reject `receiver` equal to the contract or token; tokens sent with plain `ft_transfer` are unrecoverable.
- **I-06. Event gaps.** `stream_canceled` reports the refund before it is known to have arrived; there is no event for a successful refund or `claim_owed`; `withdraw_failed` does not say where the amount went; ids and timestamps are raw u64 numbers, unsafe in JavaScript above 2^53.
- **I-07. Token parameters.** Checked on mainnet: Circle USDC's `storage_balance_bounds.min` is 0.00125 NEAR, matching the contract; a real `ft_transfer` burnt 2.3 Tgas (budget 10) and a real `storage_deposit` 2.3 Tgas (budget 5). Not checked: whether it refunds a deposit for an already-registered account, and `storage_unregister` (H-03).
- **I-08. Supply chain.** Dependencies are pinned and install scripts are disabled. There is no CI, no `pnpm audit` and no branch protection on the auto-deploying `main`.
- **I-09. Blacklisting.** A blacklisted worker can redirect pay to another receiver; a blacklisted employer's refund waits in `owed` with no alternate receiver. If Payday itself is blacklisted or USDC is paused, every transfer fails cleanly and the books stay intact.

---

## Checked and found sound

- **USDC accounting.** Stream balances plus `owed` plus in-flight amounts always equal what the contract holds. Every path debits before the call and reconciles in a callback.
- **Races.** Withdraw then cancel (both the removed and truncated outcomes), double cancel in one block, concurrent withdrawals, `claim_owed` against a new credit: none creates or loses value. Stream ids are never reused.
- **Callbacks.** Checked in near-sdk 5.30.1's generated code: a unit `Result<(), PromiseError>` is `Ok` only for a successful promise with an empty result and `Err` only for a failed one, with no result length limit. Both callbacks are `#[private]` and fit well inside their 10 Tgas.
- **Under-gassed calls.** Sandbox check: `withdraw` with 5, 12, 18 and 21 Tgas fails as a whole; the recorded withdrawal and the tokens paid always agree.
- **Batch gas.** Sandbox check: a full batch of 25 streams to 25 new workers with 250 Tgas attached (the relayer cap) succeeded, burning 63.6 Tgas, and registered every worker.
- **Vesting maths.** Exact floor of `deposit × elapsed / duration`, monotonic, no overflow at `u128::MAX` / `u64::MAX`; release builds keep overflow checks. Cancel rounding favours the employer by under one base unit and conserves the total. The web app's vesting matches the contract's.
- **Funding.** Only the configured token is accepted; amounts must sum exactly with checked addition; any panic refunds the whole transfer.
- **Access control.** `withdraw` is worker-only, `cancel` employer-or-worker; `predecessor_account_id` is the real sender under NEP-366. No method is payable.
- **Relay allowlist mechanics.** Exact receiver match, own-property method lookup, exactly one function-call action, gas caps, exact deposits, mint on testnet only and only to self. Policy inspects the same decoded object that is submitted, and a test proves re-encoding is byte-identical.
- **Secrets.** `.env.local` is ignored and untracked; no key-like string in git history or the client bundle; the relayer module is server-only.
- **Client.** No `dangerouslySetInnerHTML`, `eval` or `innerHTML`; amounts are bigint throughout; the accountant CSV is quoted correctly.

## Before mainnet, in order

1. **Make the relayer undrainable:** verify and pre-flight every delegate (H-01), stop onboarding from handing out spendable NEAR (H-02), shared rate limits with a global budget and balance floor (H-04), input caps and same-origin checks (M-06, M-07, M-09).
2. **Make callers pay for what they cause on-chain:** charge registrations and storage to the caller and register only when needed (H-03); delete settled streams, add `prune` and paginate `streams_of` (M-01, M-02).
3. **Fix key custody and the exit path:** backup/export or a real signer, CSP, a way to move USDC out and to claim `owed` (H-05, H-06, I-01).
4. **Harden deployment:** multisig owner, versioned state with migration, private `new`, reproducible build (M-03, L-05); confirm Circle USDC's `storage_unregister` and duplicate-registration behaviour (H-03, I-07).
5. **Harden cash-out:** server-side validation and deadlines, persisted deposit addresses, authenticated and rate-limited quotes, honest "unknown" outcomes (M-04, M-05, L-01).

Then re-run this review on the fixed commit, with the proof-of-concept tests flipped to assert the fixes.

## Reproducing the proof-of-concept tests

```bash
scripts/build.sh
cd contract && cargo test --test audit_poc -- --nocapture --test-threads=1
```

Each `poc_*` test passes while its issue exists and prints the figures quoted above; each `check_*` test confirms a property this report relies on. Run on 11 November 2026: 6 passed in 81 s.
