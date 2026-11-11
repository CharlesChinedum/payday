//! End-to-end tests against a local NEAR sandbox: real cross-contract calls, real async
//! transfers and refunds, using the mock USDC token from `../mock-usdc`.

mod common;

use common::*;
use near_workspaces::types::Gas;
use serde_json::json;

/// Funds Alice 1,000 and Bob 2,000 USDC, streams that started 100 s ago and run 10,000 s.
#[tokio::test]
async fn full_payroll_flow() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(5_000 * USDC).await?;
    let alice = env.sandbox.dev_create_account().await?;
    let bob = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;

    let funded = env
        .fund(
            &employer,
            &[
                (alice.id().clone(), 1_000 * USDC, now - 100, now + 10_000),
                (bob.id().clone(), 2_000 * USDC, now - 100, now + 10_000),
            ],
        )
        .await?
        .into_result()?;
    assert_eq!(events_of(&funded, "stream_created"), 2);
    assert_eq!(
        env.usdc_of(env.payday.id()).await?,
        3_000 * USDC + 2 * STREAM_FEE
    );
    assert_eq!(env.fees_collected().await?, 2 * STREAM_FEE);
    assert!(
        !env.is_registered(alice.id()).await?,
        "funding registers nobody"
    );

    let out = env
        .withdraw(&alice, json!({ "stream_id": 1 }), PAYOUT_GAS)
        .await?
        .into_result()?;
    let paid = &events(&out, "paid")[0];
    let gross = amount(&env.stream(1).await?, "withdrawn");
    assert!(gross > 0, "100+ seconds have vested");
    assert_eq!(
        amount(paid, "fee"),
        REGISTRATION_FEE,
        "first payout registers Alice"
    );
    assert_eq!(env.usdc_of(alice.id()).await?, gross - REGISTRATION_FEE);
    assert!(env.is_registered(alice.id()).await?);

    // Once registered, payouts carry no fee. A few seconds of salary have vested since.
    const SMALL: u128 = 20_000;
    let again = env
        .withdraw(
            &alice,
            json!({ "stream_id": 1, "amount": SMALL.to_string() }),
            PAYOUT_GAS,
        )
        .await?
        .into_result()?;
    assert_eq!(amount(&events(&again, "paid")[0], "fee"), 0);
    assert_eq!(
        env.usdc_of(alice.id()).await?,
        gross - REGISTRATION_FEE + SMALL
    );
    Ok(())
}

fn events_of(outcome: &impl Logs, name: &str) -> usize {
    events(outcome, name).len()
}

#[tokio::test]
async fn funding_without_fees_is_refunded() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(5_000 * USDC).await?;
    let now = env.now().await?;
    let msg = funding_msg(&[(ghost("w", 0), 1_000 * USDC, now, now + 1_000)]);
    // The token call succeeds; Payday panics in ft_on_transfer and the token refunds.
    let _ = env
        .transfer_call(&employer, 1_000 * USDC, msg, FUNDING_GAS)
        .await?;
    assert_eq!(env.usdc_of(employer.id()).await?, 5_000 * USDC);
    assert!(env.stream(1).await?.is_null());
    Ok(())
}

#[tokio::test]
async fn other_tokens_are_refunded() -> anyhow::Result<()> {
    let env = setup().await?;
    let fake = env
        .sandbox
        .dev_deploy(&std::fs::read("../mock-usdc/target/near/mock_usdc.wasm")?)
        .await?;
    fake.call("new").transact().await?.into_result()?;
    let employer = env.sandbox.dev_create_account().await?;
    for (who, amt) in [(env.payday.id(), 1), (employer.id(), 1_001 * USDC)] {
        fake.call("mint")
            .args_json(json!({ "account_id": who, "amount": amt.to_string() }))
            .transact()
            .await?
            .into_result()?;
    }
    let now = env.now().await?;
    let msg = funding_msg(&[(ghost("w", 0), 1_000 * USDC, now, now + 1_000)]);
    let _ = employer
        .call(fake.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": env.payday.id(), "amount": (1_000 * USDC + STREAM_FEE).to_string(), "msg": msg }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .gas(FUNDING_GAS)
        .transact()
        .await?;
    let back: String = fake
        .view("ft_balance_of")
        .args_json(json!({ "account_id": employer.id() }))
        .await?
        .json()?;
    assert_eq!(back, (1_001 * USDC).to_string());
    assert!(env.stream(1).await?.is_null());
    Ok(())
}

/// The 1Click case: a fresh deposit address is not registered with the token. Payday
/// registers it and deducts the registration fee from the payout.
#[tokio::test]
async fn cash_out_to_a_fresh_account_pays_the_registration_fee() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(2_000 * USDC).await?;
    let alice = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;
    env.fund(
        &employer,
        &[(alice.id().clone(), 1_000 * USDC, now - 500, now + 500)],
    )
    .await?
    .into_result()?;
    let deposit_address = ghost("deposit", 1);

    env.withdraw(
        &alice,
        json!({ "stream_id": 1, "amount": (10 * USDC).to_string(), "receiver": deposit_address }),
        PAYOUT_GAS,
    )
    .await?
    .into_result()?;
    assert_eq!(
        env.usdc_of(&deposit_address).await?,
        10 * USDC - REGISTRATION_FEE
    );
    assert_eq!(amount(&env.stream(1).await?, "withdrawn"), 10 * USDC);
    assert_eq!(env.fees_collected().await?, STREAM_FEE + REGISTRATION_FEE);
    Ok(())
}

/// A payout that cannot cover the registration fee fails and is put back in the stream.
#[tokio::test]
async fn failed_payout_is_restored_to_the_stream() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(100 * USDC).await?;
    let alice = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;
    env.fund(
        &employer,
        &[(alice.id().clone(), 10 * USDC, now - 500, now + 500)],
    )
    .await?
    .into_result()?;

    let out = env
        .withdraw(
            &alice,
            json!({ "stream_id": 1, "amount": REGISTRATION_FEE.to_string() }),
            PAYOUT_GAS,
        )
        .await?
        .into_result()?;
    let failed = &events(&out, "payout_failed")[0];
    assert_eq!(failed["credited_to"], "stream");
    assert_eq!(amount(&env.stream(1).await?, "withdrawn"), 0);
    assert_eq!(env.usdc_of(env.payday.id()).await?, 10 * USDC + STREAM_FEE);
    assert_eq!(env.usdc_of(alice.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn cancel_splits_funds_exactly() -> anyhow::Result<()> {
    let env = setup().await?;
    let deposit = 1_000 * USDC;
    let employer = env.account_with(deposit + STREAM_FEE).await?;
    let alice = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;
    env.fund(
        &employer,
        &[(alice.id().clone(), deposit, now - 500, now + 500)],
    )
    .await?
    .into_result()?;

    let canceled = env.cancel(&employer, 1).await?.into_result()?;
    let refund = env.usdc_of(employer.id()).await?;
    assert!(refund > 0 && refund < deposit);
    assert_eq!(
        events(&canceled, "stream_canceled")[0]["worker_remaining_to"],
        "stream"
    );

    env.withdraw(&alice, json!({ "stream_id": 1 }), PAYOUT_GAS)
        .await?
        .into_result()?;
    let earned = env.usdc_of(alice.id()).await?;

    assert_eq!(
        refund + earned + REGISTRATION_FEE,
        deposit,
        "every unit is accounted for"
    );
    assert_eq!(
        env.usdc_of(env.payday.id()).await?,
        STREAM_FEE + REGISTRATION_FEE,
        "only fees remain"
    );
    assert!(
        env.stream(1).await?.is_null(),
        "the settled stream is deleted"
    );
    assert_eq!(env.stream_count_of(alice.id()).await?, 0);
    Ok(())
}

/// The exit path: USDC held by an account is sent on through Payday, which registers the
/// receiver for the fee.
#[tokio::test]
async fn send_moves_usdc_out_of_an_account() -> anyhow::Result<()> {
    let env = setup().await?;
    let holder = env.account_with(50 * USDC).await?;
    let receiver = ghost("exit", 1);

    let out = env
        .transfer_call(
            &holder,
            20 * USDC,
            json!({ "send_to": receiver }).to_string(),
            FUNDING_GAS,
        )
        .await?
        .into_result()?;
    assert_eq!(amount(&events(&out, "paid")[0], "fee"), REGISTRATION_FEE);
    assert_eq!(env.usdc_of(&receiver).await?, 20 * USDC - REGISTRATION_FEE);
    assert_eq!(env.usdc_of(holder.id()).await?, 30 * USDC);
    assert_eq!(env.owed_of(holder.id()).await?, 0);
    Ok(())
}

/// The owner can upgrade the contract through the contract itself, so the account needs
/// no full-access key; `migrate` keeps every stream.
#[tokio::test]
async fn owner_upgrade_keeps_state() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(100 * USDC).await?;
    let now = env.now().await?;
    env.fund(&employer, &[(ghost("w", 0), 10 * USDC, now, now + 1_000)])
        .await?
        .into_result()?;

    let stranger = env.sandbox.dev_create_account().await?;
    let refused = stranger
        .call(env.payday.id(), "upgrade")
        .args(payday_wasm()?)
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert!(refused.is_failure(), "only the owner may upgrade");

    env.owner
        .call(env.payday.id(), "upgrade")
        .args(payday_wasm()?)
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(amount(&env.stream(1).await?, "deposit"), 10 * USDC);
    assert_eq!(env.config().await?["owner"], env.owner.id().to_string());
    Ok(())
}

#[tokio::test]
async fn new_cannot_be_called_by_others() -> anyhow::Result<()> {
    let sandbox = near_workspaces::sandbox().await?;
    let payday = sandbox.dev_deploy(&payday_wasm()?).await?;
    let squatter = sandbox.dev_create_account().await?;
    let out = squatter
        .call(payday.id(), "new")
        .args_json(json!({ "token": squatter.id(), "owner": squatter.id() }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(out.is_failure(), "initialisation is private");
    Ok(())
}
