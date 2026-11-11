//! Shared sandbox setup for the integration and security tests. Contracts are built with
//! `scripts/build.sh` first.
#![allow(dead_code)] // each test crate uses a different subset

use near_workspaces::network::Sandbox;
use near_workspaces::result::{ExecutionFinalResult, ExecutionResult};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

pub const USDC: u128 = 1_000_000;
pub const STREAM_FEE: u128 = 10_000;
pub const REGISTRATION_FEE: u128 = 10_000;
pub const REGISTRATION_YOCTO: u128 = 1_250_000_000_000_000_000_000;
pub const MAX_GAS: Gas = Gas::from_tgas(300);
pub const PAYOUT_GAS: Gas = Gas::from_tgas(100);
pub const FUNDING_GAS: Gas = Gas::from_tgas(150);
const MINT_CHUNK: u128 = 10_000 * USDC;

pub struct Env {
    pub sandbox: Worker<Sandbox>,
    pub usdc: Contract,
    pub payday: Contract,
    pub owner: Account,
}

fn wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}. Run scripts/build.sh first."))
}

pub fn payday_wasm() -> anyhow::Result<Vec<u8>> {
    wasm("target/near/payday.wasm")
}

pub async fn setup() -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let usdc = sandbox
        .dev_deploy(&wasm("../mock-usdc/target/near/mock_usdc.wasm")?)
        .await?;
    usdc.call("new").transact().await?.into_result()?;

    let owner = sandbox.dev_create_account().await?;
    let payday = sandbox.dev_deploy(&payday_wasm()?).await?;
    payday
        .call("new")
        .args_json(json!({ "token": usdc.id(), "owner": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    // The contract must be registered with the token to receive it.
    usdc.call("storage_deposit")
        .args_json(json!({ "account_id": payday.id(), "registration_only": true }))
        .deposit(NearToken::from_yoctonear(REGISTRATION_YOCTO))
        .transact()
        .await?
        .into_result()?;
    Ok(Env {
        sandbox,
        usdc,
        payday,
        owner,
    })
}

/// One stream to fund: worker, amount, start and stop in Unix seconds.
pub type StreamSpec = (AccountId, u128, u64, u64);

impl Env {
    /// A funded account holding `usdc` test USDC (and so registered with the token).
    pub async fn account_with(&self, usdc: u128) -> anyhow::Result<Account> {
        let account = self.sandbox.dev_create_account().await?;
        self.mint(account.id(), usdc).await?;
        Ok(account)
    }

    pub async fn mint(&self, to: &AccountId, mut amount: u128) -> anyhow::Result<()> {
        while amount > 0 {
            let chunk = amount.min(MINT_CHUNK);
            self.usdc
                .call("mint")
                .args_json(json!({ "account_id": to, "amount": chunk.to_string() }))
                .transact()
                .await?
                .into_result()?;
            amount -= chunk;
        }
        Ok(())
    }

    pub async fn now(&self) -> anyhow::Result<u64> {
        Ok(self.sandbox.view_block().await?.timestamp() / 1_000_000_000)
    }

    pub async fn wait_until(&self, secs: u64) -> anyhow::Result<()> {
        while self.now().await? <= secs {
            self.sandbox.fast_forward(5).await?;
        }
        Ok(())
    }

    pub async fn usdc_of(&self, id: &AccountId) -> anyhow::Result<u128> {
        let v: String = self
            .usdc
            .view("ft_balance_of")
            .args_json(json!({ "account_id": id }))
            .await?
            .json()?;
        Ok(v.parse()?)
    }

    pub async fn is_registered(&self, id: &AccountId) -> anyhow::Result<bool> {
        let v: Option<Value> = self
            .usdc
            .view("storage_balance_of")
            .args_json(json!({ "account_id": id }))
            .await?
            .json()?;
        Ok(v.is_some())
    }

    pub async fn near_of_payday(&self) -> anyhow::Result<u128> {
        Ok(self.payday.view_account().await?.balance.as_yoctonear())
    }

    pub async fn storage_of_payday(&self) -> anyhow::Result<u64> {
        Ok(self.payday.view_account().await?.storage_usage)
    }

    pub async fn stream(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self
            .payday
            .view("get_stream")
            .args_json(json!({ "stream_id": id }))
            .await?
            .json()?)
    }

    pub async fn config(&self) -> anyhow::Result<Value> {
        Ok(self.payday.view("config").await?.json()?)
    }

    pub async fn fees_collected(&self) -> anyhow::Result<u128> {
        Ok(self.config().await?["fees_collected"]
            .as_str()
            .unwrap()
            .parse()?)
    }

    pub async fn owed_of(&self, id: &AccountId) -> anyhow::Result<u128> {
        let v: String = self
            .payday
            .view("owed_of")
            .args_json(json!({ "account_id": id }))
            .await?
            .json()?;
        Ok(v.parse()?)
    }

    pub async fn streams_of(
        &self,
        id: &AccountId,
        from: u32,
        limit: u32,
    ) -> anyhow::Result<Vec<Value>> {
        Ok(self
            .payday
            .view("streams_of")
            .args_json(json!({ "account_id": id, "from_index": from, "limit": limit }))
            .await?
            .json()?)
    }

    pub async fn stream_count_of(&self, id: &AccountId) -> anyhow::Result<u32> {
        Ok(self
            .payday
            .view("stream_count_of")
            .args_json(json!({ "account_id": id }))
            .await?
            .json()?)
    }

    /// Funds streams paying exactly amounts plus stream fees. Returns the outcome.
    pub async fn fund(
        &self,
        employer: &Account,
        streams: &[StreamSpec],
    ) -> anyhow::Result<ExecutionFinalResult> {
        let total: u128 = streams.iter().map(|s| s.1 + STREAM_FEE).sum();
        self.transfer_call(employer, total, funding_msg(streams), FUNDING_GAS)
            .await
    }

    pub async fn transfer_call(
        &self,
        from: &Account,
        amount: u128,
        msg: String,
        gas: Gas,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(from
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": self.payday.id(), "amount": amount.to_string(), "msg": msg }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(gas)
            .transact()
            .await?)
    }

    pub async fn withdraw(
        &self,
        worker: &Account,
        args: Value,
        gas: Gas,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(worker
            .call(self.payday.id(), "withdraw")
            .args_json(args)
            .gas(gas)
            .transact()
            .await?)
    }

    pub async fn cancel(&self, caller: &Account, id: u64) -> anyhow::Result<ExecutionFinalResult> {
        Ok(caller
            .call(self.payday.id(), "cancel")
            .args_json(json!({ "stream_id": id }))
            .gas(PAYOUT_GAS)
            .transact()
            .await?)
    }
}

pub fn funding_msg(streams: &[StreamSpec]) -> String {
    let list: Vec<Value> = streams
        .iter()
        .map(|(w, a, s, e)| json!({ "worker": w, "amount": a.to_string(), "start": s, "stop": e }))
        .collect();
    json!({ "streams": list }).to_string()
}

/// Anything that carries the logs of every receipt of a transaction.
pub trait Logs {
    fn receipt_logs(&self) -> Vec<&str>;
}

impl Logs for ExecutionFinalResult {
    fn receipt_logs(&self) -> Vec<&str> {
        self.logs()
    }
}

impl Logs for ExecutionResult<near_workspaces::result::Value> {
    fn receipt_logs(&self) -> Vec<&str> {
        self.logs()
    }
}

/// Every Payday event named `name` across all receipts of an outcome.
pub fn events(outcome: &impl Logs, name: &str) -> Vec<Value> {
    outcome
        .receipt_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter(|e| e["standard"] == "payday" && e["event"] == name)
        .map(|e| e["data"][0].clone())
        .collect()
}

pub fn amount(v: &Value, field: &str) -> u128 {
    v[field].as_str().expect("U128 string").parse().unwrap()
}

pub fn ghost(prefix: &str, i: usize) -> AccountId {
    format!("{prefix}-{i}.near").parse().unwrap()
}

pub fn near(yocto: u128) -> f64 {
    yocto as f64 / 1e24
}
