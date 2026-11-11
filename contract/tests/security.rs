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
/// registration fee.
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
        USDC - REGISTRATION_FEE
    );
    assert_eq!(
        env.fees_collected().await?,
        STREAM_FEE + 10 * REGISTRATION_FEE
    );
    println!(
        "H-03  10 cash-outs to fresh accounts: worker paid {} USDC in registration fees for {:.5} NEAR of registrations",
        (10 * REGISTRATION_FEE) as f64 / 1e6,
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
    let sink = env.account_with(1).await?; // registered, so payouts carry no fee
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
    assert!(
        storage_after <= storage_before + 64,
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
                json!({ "stream_id": 1, "amount": "100000" }),
                Gas::from_tgas(tgas),
            )
            .await?;
        let withdrawn = amount(&env.stream(1).await?, "withdrawn");
        let paid = env.usdc_of(worker.id()).await?;
        let fees = env.fees_collected().await? - STREAM_FEE;
        println!(
            "CHECK withdraw with {tgas} Tgas: success={}, withdrawn={withdrawn}, worker holds {paid}, registration fees {fees}",
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
