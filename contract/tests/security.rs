//! Regression tests for the November 2026 security review (see AUDIT.md).
//!
//! Each `fixed_*` test replays the attack from the review's proof of concept and asserts
//! it no longer works, printing the figures quoted in AUDIT.md. Each `check_*` test
//! confirms a property the review relies on.
//! Run with: cargo test --test security -- --nocapture --test-threads=1

mod common;

use common::*;
use near_workspaces::types::Gas;
use serde_json::{json, Value};

/// H-03 (was F-01): funding then cancelling 25 unstarted streams to fresh accounts used to
/// cost the contract 25 registrations and the attacker nothing. Now funding registers
/// nobody, and every cycle costs the attacker the stream fees.
#[tokio::test]
async fn fixed_h03_fund_then_cancel_costs_the_attacker() -> anyhow::Result<()> {
    let env = setup().await?;
    let attacker = env.account_with(25 * (USDC + STREAM_FEE)).await?;
    let now = env.now().await?;
    let streams: Vec<_> = (0..25)
        .map(|i| (ghost("f01", i), USDC, now + 10_000, now + 20_000))
        .collect();

    let near_before = env.near_of_payday().await?;
    env.fund(&attacker, &streams).await?.into_result()?;
    for id in 1..=25u64 {
        env.cancel(&attacker, id).await?.into_result()?;
    }
    let near_after = env.near_of_payday().await?;

    assert_eq!(
        env.usdc_of(attacker.id()).await?,
        25 * USDC,
        "attacker lost the 25 stream fees"
    );
    assert_eq!(env.fees_collected().await?, 25 * STREAM_FEE);
    assert!(
        !env.is_registered(&ghost("f01", 0)).await?,
        "nobody was registered"
    );
    assert!(
        near_after + REGISTRATION_YOCTO / 10 >= near_before,
        "contract spent {} NEAR",
        near(near_before.saturating_sub(near_after))
    );
    println!(
        "H-03  fund+cancel 25 streams: contract NEAR change {:+.5}, attacker paid {} USDC in fees",
        (near_after as f64 - near_before as f64) / 1e24,
        (25 * STREAM_FEE) as f64 / 1e6
    );
    Ok(())
}

/// H-03 (was F-04): ten 1 USDC cash-outs to fresh accounts used to cost the contract ten
/// registrations for free. Now each payout to an unregistered account carries the
/// registration fee, on top of the payout fee every payout carries (N-01).
#[tokio::test]
async fn fixed_h03_cash_outs_pay_their_own_registration() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(20 * USDC + STREAM_FEE).await?;
    let worker = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;
    env.fund(
        &employer,
        &[(worker.id().clone(), 20 * USDC, now - 1_000, now + 30)],
    )
    .await?
    .into_result()?;
    env.wait_until(now + 30).await?;

    for i in 0..10 {
        env.withdraw(
            &worker,
            json!({ "stream_id": 1, "amount": USDC.to_string(), "receiver": ghost("f04", i) }),
            PAYOUT_GAS,
        )
        .await?
        .into_result()?;
    }

    assert_eq!(
        env.usdc_of(&ghost("f04", 9)).await?,
        USDC - PAYOUT_FEE - REGISTRATION_FEE
    );
    assert_eq!(
        env.fees_collected().await?,
        STREAM_FEE + 10 * (PAYOUT_FEE + REGISTRATION_FEE)
    );
    println!(
        "H-03  10 cash-outs to fresh accounts: worker paid {} USDC in fees for {:.5} NEAR of registrations",
        (10 * (PAYOUT_FEE + REGISTRATION_FEE)) as f64 / 1e6,
        near(10 * REGISTRATION_YOCTO)
    );
    Ok(())
}

/// M-01 (was F-02): finished, fully paid streams used to stay in storage forever. Now
/// the last payout deletes them and storage returns to where it started.
#[tokio::test]
async fn fixed_m01_settled_streams_are_deleted() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(25 * (USDC + STREAM_FEE)).await?;
    let sink = env.account_with(1).await?; // registered, so payouts carry only the payout fee
    let now = env.now().await?;
    let streams: Vec<_> = (0..25)
        .map(|_| (sink.id().clone(), USDC, now - 100, now + 3))
        .collect();

    let storage_before = env.storage_of_payday().await?;
    env.fund(&employer, &streams).await?.into_result()?;
    env.wait_until(now + 3).await?;
    for id in 1..=25u64 {
        env.withdraw(&sink, json!({ "stream_id": id }), PAYOUT_GAS)
            .await?
            .into_result()?;
    }
    let storage_after = env.storage_of_payday().await?;

    assert!(env.stream(1).await?.is_null() && env.stream(25).await?.is_null());
    assert_eq!(env.stream_count_of(sink.id()).await?, 0);
    assert_eq!(env.stream_count_of(employer.id()).await?, 0);
    // Nothing per stream. What remains is the worker's one `owed` entry, kept since review 3
    // (M-1) so a failed payout never needs new storage: one per account, not per stream.
    let owed_entry = 61 + sink.id().as_str().len() as u64;
    assert!(
        storage_after <= storage_before + owed_entry + 64,
        "storage grew {} bytes",
        storage_after - storage_before
    );
    println!(
        "M-01  storage after 25 settled streams: {:+} bytes",
        storage_after as i64 - storage_before as i64
    );
    Ok(())
}

/// M-02 (was F-03): a stream cancelled just after it started used to stay in the victim's
/// list for good. Now the dust moves to the victim's owed balance and the stream is
/// deleted, and `streams_of` pages.
#[tokio::test]
async fn fixed_m02_dust_streams_do_not_stick() -> anyhow::Result<()> {
    let env = setup().await?;
    let attacker = env.account_with(100 * USDC).await?;
    let victim = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;

    env.fund(
        &attacker,
        &[(victim.id().clone(), USDC, now - 2_000, now + 100_000_000)],
    )
    .await?
    .into_result()?;
    let canceled = env.cancel(&attacker, 1).await?.into_result()?;

    assert_eq!(
        events(&canceled, "stream_canceled")[0]["worker_remaining_to"],
        "owed"
    );
    assert!(env.stream(1).await?.is_null());
    assert_eq!(env.stream_count_of(victim.id()).await?, 0);
    let dust = env.owed_of(victim.id()).await?;
    assert!(dust > 0 && dust < USDC);

    let streams: Vec<_> = (0..25)
        .map(|_| (victim.id().clone(), USDC, now, now + 1_000))
        .collect();
    env.fund(&attacker, &streams).await?.into_result()?;
    let page: Vec<Value> = env.streams_of(victim.id(), 20, 10).await?;
    assert_eq!(page.len(), 5);
    println!(
        "M-02  dust stream deleted on cancel; {dust} base units moved to the victim's owed balance; streams_of pages ({} of 25 from index 20)",
        page.len()
    );
    Ok(())
}

/// A full batch of 25 streams fits comfortably within the relayer's funding gas cap.
#[tokio::test]
async fn check_full_batch_fits_the_relayer_gas_cap() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(25 * (USDC + STREAM_FEE)).await?;
    let now = env.now().await?;
    let streams: Vec<_> = (0..25)
        .map(|i| (ghost("batch", i), USDC, now, now + 1_000))
        .collect();

    let outcome = env.fund(&employer, &streams).await?;
    let burnt = outcome.total_gas_burnt.as_gas();
    outcome.into_result()?;

    assert!(!env.stream(25).await?.is_null());
    println!(
        "CHECK full batch of 25 with {} Tgas attached: ok, {:.1} Tgas burnt",
        FUNDING_GAS.as_tgas(),
        burnt as f64 / 1e12
    );
    Ok(())
}

/// A payout with too little gas for its whole chain must fail as a whole: the books may
/// not move unless every callback is guaranteed to run.
#[tokio::test]
async fn check_underfunded_payouts_change_nothing() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(10 * USDC + STREAM_FEE).await?;
    let worker = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;
    env.fund(
        &employer,
        &[(worker.id().clone(), 10 * USDC, now - 500, now + 500)],
    )
    .await?
    .into_result()?;

    for tgas in [10u64, 40, 70, 85, 100] {
        let outcome = env
            .withdraw(
                &worker,
                json!({ "stream_id": 1, "amount": USDC.to_string() }),
                Gas::from_tgas(tgas),
            )
            .await?;
        let withdrawn = amount(&env.stream(1).await?, "withdrawn");
        let paid = env.usdc_of(worker.id()).await?;
        let fees = env.fees_collected().await? - STREAM_FEE;
        println!(
            "CHECK withdraw with {tgas} Tgas: success={}, withdrawn={withdrawn}, worker holds {paid}, payout fees {fees}",
            outcome.is_success()
        );
        assert_eq!(
            withdrawn,
            paid + fees,
            "books, tokens and fees must agree after a {tgas} Tgas withdraw"
        );
    }
    Ok(())
}

/// The contract's USDC balance always equals what it owes: what is left in live streams,
/// every `owed` balance, and the fees collected. Checked after every step of a mixed run
/// that includes a failed payout and a fee withdrawal.
#[tokio::test]
async fn check_books_match_the_token_balance() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(100 * USDC).await?;
    let alice = env.sandbox.dev_create_account().await?;
    let bob = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;
    let accounts = [employer.id().clone(), alice.id().clone(), bob.id().clone()];

    let check = |step: &'static str| {
        let env = &env;
        let accounts = &accounts;
        async move {
            let mut held = env.fees_collected().await?;
            let mut seen = std::collections::BTreeSet::new();
            for id in accounts {
                held += env.owed_of(id).await?;
                for s in env.streams_of(id, 0, 100).await? {
                    if seen.insert(s["id"].as_u64().unwrap()) {
                        held += amount(&s, "deposit") - amount(&s, "withdrawn");
                    }
                }
            }
            let balance = env.usdc_of(env.payday.id()).await?;
            assert_eq!(
                balance, held,
                "books and token balance differ after: {step}"
            );
            println!("CHECK books = token balance = {balance} after: {step}");
            anyhow::Ok(())
        }
    };

    env.fund(
        &employer,
        &[
            (alice.id().clone(), 30 * USDC, now - 1_000, now + 1_000),
            (bob.id().clone(), 20 * USDC, now - 100, now + 100_000),
        ],
    )
    .await?
    .into_result()?;
    check("funding two streams").await?;

    env.withdraw(
        &alice,
        json!({ "stream_id": 1, "amount": (5 * USDC).to_string() }),
        PAYOUT_GAS,
    )
    .await?
    .into_result()?;
    check("a withdrawal that registers Alice").await?;

    env.owner
        .call(env.payday.id(), "set_fees")
        .args_json(json!({
            "stream_fee": STREAM_FEE.to_string(),
            "registration_fee": USDC.to_string(),
            "payout_fee": PAYOUT_FEE.to_string(),
        }))
        .transact()
        .await?
        .into_result()?;
    env.withdraw(
        &alice,
        json!({ "stream_id": 1, "amount": USDC.to_string(), "receiver": ghost("books", 0) }),
        PAYOUT_GAS,
    )
    .await?
    .into_result()?;
    check("a payout that fails on its fees").await?;

    env.cancel(&employer, 2).await?.into_result()?;
    check("cancelling Bob's stream (dust to owed)").await?;

    env.mint(env.owner.id(), 1).await?; // registered, so all of it reaches the owner
    let fees = env.fees_collected().await?;
    env.owner
        .call(env.payday.id(), "withdraw_fees")
        .args_json(json!({ "amount": fees.to_string(), "receiver": env.owner.id() }))
        .gas(PAYOUT_GAS)
        .transact()
        .await?
        .into_result()?;
    check("the owner withdrawing every fee").await?;

    env.transfer_call(
        &employer,
        2 * USDC,
        json!({ "send_to": bob.id() }).to_string(),
        FUNDING_GAS,
    )
    .await?
    .into_result()?;
    check("a send to Bob").await?;
    Ok(())
}

/// Review 3, M-1: failed payouts used to write new `owed` entries with no reserve check,
/// so they could eat the NEAR reserve, after which a failed payout could not record what
/// it owed and the USDC was lost. Now a payout reserves that storage up front, and is
/// refused (the send is refunded) if Payday cannot afford it.
#[tokio::test]
async fn fixed_review3_m1_failed_payouts_never_lose_usdc_near_the_reserve() -> anyhow::Result<()> {
    const BYTE: u128 = 10_000_000_000_000_000_000;
    const RESERVE_BYTES: i128 = 25_000;
    let sandbox = near_workspaces::sandbox().await?;
    let usdc = sandbox
        .dev_deploy(&std::fs::read("../mock-usdc/target/near/mock_usdc.wasm")?)
        .await?;
    usdc.call("new").transact().await?.into_result()?;
    let root = sandbox.root_account()?;
    let owner = sandbox.dev_create_account().await?;
    let wasm = payday_wasm()?;
    let account = root
        .create_subaccount("payday")
        .initial_balance(near_workspaces::types::NearToken::from_yoctonear(
            (wasm.len() as u128 + 2_000) * BYTE,
        ))
        .transact()
        .await?
        .into_result()?;
    let payday = account.deploy(&wasm).await?.into_result()?;
    payday
        .call("new")
        .args_json(json!({ "token": usdc.id(), "owner": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(usdc.id(), "storage_deposit")
        .args_json(json!({ "account_id": payday.id(), "registration_only": true }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(
            REGISTRATION_YOCTO,
        ))
        .transact()
        .await?
        .into_result()?;
    let env = Env {
        sandbox,
        usdc,
        payday,
        owner,
    };
    let free_bytes = || async {
        let a = env.payday.view_account().await?;
        anyhow::Ok(
            (a.balance.as_yoctonear() as i128 - a.storage_usage as i128 * BYTE as i128)
                / BYTE as i128,
        )
    };
    // Just above the reserve: room for one `owed` entry, not for a registration.
    let top_up = (RESERVE_BYTES + 160 - free_bytes().await?) as u128 * BYTE;
    root.transfer_near(
        env.payday.id(),
        near_workspaces::types::NearToken::from_yoctonear(top_up),
    )
    .await?
    .into_result()?;

    // Fresh senders send to receivers Payday cannot afford to register. The first payout
    // fails into the sender's `owed`; later ones are refused up front and refunded. Either
    // way every unit is with the sender, owed to them, with the receiver, or in fees.
    let mut outcomes = Vec::new();
    for i in 0..6 {
        let sender = env.account_with(5 * USDC).await?;
        let receiver = ghost("m1", i);
        let fees_before = env.fees_collected().await?;
        // Success or refund are both fine here; what matters is where the USDC ends up.
        let _outcome = env
            .transfer_call(
                &sender,
                5 * USDC,
                json!({ "send_to": receiver }).to_string(),
                FUNDING_GAS,
            )
            .await?;
        let refunded = env.usdc_of(sender.id()).await?;
        let owed = env.owed_of(sender.id()).await?;
        let delivered = env.usdc_of(&receiver).await.unwrap_or(0);
        let fees = env.fees_collected().await? - fees_before;
        assert_eq!(
            refunded + owed + delivered + fees,
            5 * USDC,
            "send {i}: USDC unaccounted for"
        );
        assert!(
            free_bytes().await? >= RESERVE_BYTES,
            "send {i}: the reserve was eaten"
        );
        outcomes.push((refunded, owed, delivered));
    }
    println!("M-1 outcomes (refunded, owed, delivered): {outcomes:?}");
    assert!(
        outcomes.iter().any(|o| o.1 == 5 * USDC),
        "the failure path was exercised"
    );
    assert!(
        outcomes.iter().any(|o| o.0 == 5 * USDC),
        "the up-front refusal was exercised"
    );
    Ok(())
}
