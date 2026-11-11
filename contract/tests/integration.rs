//! End-to-end tests against a local NEAR sandbox: real cross-contract calls, real
//! async transfers and refunds, using the mock USDC token from `../mock-usdc`.

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const USDC: u128 = 1_000_000;
const STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);

/// Contracts are built with `cargo near build non-reproducible-wasm` in each crate first
/// (`scripts/build.sh` does both).
fn wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}. Run scripts/build.sh first."))
}

struct Env {
    sandbox: Worker<Sandbox>,
    usdc: Contract,
    payday: Contract,
    employer: Account,
    alice: Account,
    bob: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let usdc_wasm = wasm("../mock-usdc/target/near/mock_usdc.wasm")?;
    let payday_wasm = wasm("target/near/payday.wasm")?;

    let usdc = sandbox.dev_deploy(&usdc_wasm).await?;
    usdc.call("new").transact().await?.into_result()?;

    let payday = sandbox.dev_deploy(&payday_wasm).await?;
    payday
        .call("new")
        .args_json(json!({ "token": usdc.id() }))
        .transact()
        .await?
        .into_result()?;

    let employer = sandbox.dev_create_account().await?;
    let alice = sandbox.dev_create_account().await?;
    let bob = sandbox.dev_create_account().await?;

    // The contract must be registered with the token to receive it.
    employer
        .call(usdc.id(), "storage_deposit")
        .args_json(json!({ "account_id": payday.id(), "registration_only": true }))
        .deposit(STORAGE)
        .transact()
        .await?
        .into_result()?;
    employer
        .call(usdc.id(), "mint")
        .args_json(json!({ "account_id": employer.id(), "amount": (5_000 * USDC).to_string() }))
        .transact()
        .await?
        .into_result()?;

    Ok(Env {
        sandbox,
        usdc,
        payday,
        employer,
        alice,
        bob,
    })
}

async fn now_secs(env: &Env) -> anyhow::Result<u64> {
    Ok(env.sandbox.view_block().await?.timestamp() / 1_000_000_000)
}

async fn balance(env: &Env, account: &near_workspaces::AccountId) -> anyhow::Result<u128> {
    let v: String = env
        .usdc
        .view("ft_balance_of")
        .args_json(json!({ "account_id": account }))
        .await?
        .json()?;
    Ok(v.parse()?)
}

async fn stream(env: &Env, id: u64) -> anyhow::Result<Value> {
    Ok(env
        .payday
        .view("get_stream")
        .args_json(json!({ "stream_id": id }))
        .await?
        .json()?)
}

fn amount(v: &Value, field: &str) -> u128 {
    v[field].as_str().expect("U128 string").parse().unwrap()
}

/// Employer funds `streams` (worker, amount) that started 100 s ago and run 10,000 s.
async fn fund(env: &Env, streams: &[(&Account, u128)], sent: u128) -> anyhow::Result<()> {
    let now = now_secs(env).await?;
    let list: Vec<Value> = streams
        .iter()
        .map(|(w, a)| {
            json!({ "worker": w.id(), "amount": a.to_string(), "start": now - 100, "stop": now + 10_000 })
        })
        .collect();
    env.employer
        .call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.payday.id(),
            "amount": sent.to_string(),
            "msg": json!({ "streams": list }).to_string(),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn full_payroll_flow() -> anyhow::Result<()> {
    let env = setup().await?;
    fund(
        &env,
        &[(&env.alice, 1_000 * USDC), (&env.bob, 2_000 * USDC)],
        3_000 * USDC,
    )
    .await?;

    assert_eq!(balance(&env, env.payday.id()).await?, 3_000 * USDC);
    assert_eq!(balance(&env, env.employer.id()).await?, 2_000 * USDC);

    // Alice never touched the token, yet funding registered her so she can receive.
    let reg: Option<Value> = env
        .usdc
        .view("storage_balance_of")
        .args_json(json!({ "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert!(
        reg.is_some(),
        "worker should be registered with the token at funding"
    );

    let streams: Vec<Value> = env
        .payday
        .view("streams_of")
        .args_json(json!({ "account_id": env.employer.id() }))
        .await?
        .json()?;
    assert_eq!(streams.len(), 2);

    let ok: bool = env
        .alice
        .call(env.payday.id(), "withdraw")
        .args_json(json!({ "stream_id": 1 }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert!(ok);

    let s = stream(&env, 1).await?;
    let withdrawn = amount(&s, "withdrawn");
    assert!(withdrawn > 0, "100+ seconds have vested");
    assert_eq!(balance(&env, env.alice.id()).await?, withdrawn);
    assert_eq!(
        balance(&env, env.payday.id()).await?,
        3_000 * USDC - withdrawn
    );
    Ok(())
}

#[tokio::test]
async fn mismatched_total_is_refunded() -> anyhow::Result<()> {
    let env = setup().await?;
    // The token call itself succeeds; Payday panics in ft_on_transfer and the token's
    // resolver refunds the full amount, so the outcome is ignored and balances checked.
    let _ = fund(&env, &[(&env.alice, 1_000 * USDC)], 1_500 * USDC).await;
    assert_eq!(balance(&env, env.employer.id()).await?, 5_000 * USDC);
    assert_eq!(balance(&env, env.payday.id()).await?, 0);
    assert!(stream(&env, 1).await?.is_null());
    Ok(())
}

#[tokio::test]
async fn other_tokens_are_refunded() -> anyhow::Result<()> {
    let env = setup().await?;
    let fake_wasm = wasm("../mock-usdc/target/near/mock_usdc.wasm")?;
    let fake = env.sandbox.dev_deploy(&fake_wasm).await?;
    fake.call("new").transact().await?.into_result()?;
    for (who, amt) in [(env.payday.id(), 1), (env.employer.id(), 1_000 * USDC)] {
        env.employer
            .call(fake.id(), "mint")
            .args_json(json!({ "account_id": who, "amount": amt.to_string() }))
            .transact()
            .await?
            .into_result()?;
    }

    let now = now_secs(&env).await?;
    let msg = json!({ "streams": [{ "worker": env.alice.id(), "amount": (1_000 * USDC).to_string(), "start": now, "stop": now + 1_000 }] });
    let _ = env
        .employer
        .call(fake.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": env.payday.id(), "amount": (1_000 * USDC).to_string(), "msg": msg.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;

    let back: String = fake
        .view("ft_balance_of")
        .args_json(json!({ "account_id": env.employer.id() }))
        .await?
        .json()?;
    assert_eq!(back, (1_000 * USDC).to_string());
    assert!(stream(&env, 1).await?.is_null());
    Ok(())
}

/// The 1Click risk case: withdrawing to a receiver the token does not know.
/// The transfer fails and the callback must credit the stream back in full.
#[tokio::test]
async fn failed_withdraw_to_unregistered_receiver_is_restored() -> anyhow::Result<()> {
    let env = setup().await?;
    fund(&env, &[(&env.alice, 1_000 * USDC)], 1_000 * USDC).await?;
    let stranger = env.sandbox.dev_create_account().await?;

    let ok: bool = env
        .alice
        .call(env.payday.id(), "withdraw")
        .args_json(json!({ "stream_id": 1, "amount": USDC.to_string(), "receiver": stranger.id() }))
        .max_gas()
        .transact()
        .await?
        .json()?;
    assert!(!ok, "transfer to an unregistered account must fail");
    assert_eq!(amount(&stream(&env, 1).await?, "withdrawn"), 0);
    assert_eq!(balance(&env, env.payday.id()).await?, 1_000 * USDC);

    // Funds are not stuck: a normal withdrawal still works.
    let ok: bool = env
        .alice
        .call(env.payday.id(), "withdraw")
        .args_json(json!({ "stream_id": 1, "amount": USDC.to_string() }))
        .max_gas()
        .transact()
        .await?
        .json()?;
    assert!(ok);
    assert_eq!(balance(&env, env.alice.id()).await?, USDC);
    Ok(())
}

#[tokio::test]
async fn cancel_splits_funds_exactly() -> anyhow::Result<()> {
    let env = setup().await?;
    let deposit = 1_000 * USDC;
    fund(&env, &[(&env.alice, deposit)], deposit).await?;
    let employer_before = balance(&env, env.employer.id()).await?;

    env.employer
        .call(env.payday.id(), "cancel")
        .args_json(json!({ "stream_id": 1 }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let refund = balance(&env, env.employer.id()).await? - employer_before;
    assert!(refund > 0 && refund < deposit);

    env.alice
        .call(env.payday.id(), "withdraw")
        .args_json(json!({ "stream_id": 1 }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let earned = balance(&env, env.alice.id()).await?;

    assert_eq!(
        refund + earned,
        deposit,
        "every unit goes to the employer or the worker"
    );
    assert_eq!(balance(&env, env.payday.id()).await?, 0);
    Ok(())
}
