//! Payday: per-second USDC payroll streams on NEAR.
//!
//! An employer funds one or more streams in a single `ft_transfer_call` on the USDC
//! contract. Each stream vests linearly from `start` to `stop` (Unix seconds). The
//! worker withdraws whatever has vested, either to their own account or to any
//! account they name (e.g. a NEAR Intents 1Click deposit address for cross-chain
//! cash-out). Either party can cancel: the employer is refunded the unvested part and
//! the worker keeps the vested part.
//!
//! NEAR transfers are asynchronous, so every outgoing transfer updates state first and
//! reconciles in a callback. A failed transfer is credited back to the stream, or, if
//! the stream no longer exists, to the account's `owed` balance (see `claim_owed`).
//!
//! Storage for streams is paid by this contract; `MIN_STREAM_AMOUNT` and `MAX_BATCH`
//! bound how cheaply that storage can be consumed.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

#[cfg(test)]
mod tests;

/// 1 USDC (6 decimals). Smaller streams are rejected to keep storage griefing costly.
pub const MIN_STREAM_AMOUNT: u128 = 1_000_000;
/// Maximum streams created by one funding transfer, to stay well inside the gas limit.
pub const MAX_BATCH: usize = 50;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NANOS_PER_SEC: u64 = 1_000_000_000;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Streams,
    ByAccount,
    Owed,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Stream {
    pub employer: AccountId,
    pub worker: AccountId,
    pub deposit: u128,
    pub withdrawn: u128,
    pub start: u64,
    pub stop: u64,
}

impl Stream {
    /// Linear vesting, rounded down. Split into quotient and remainder so that
    /// `deposit * elapsed` cannot overflow u128: `r * e < d * d < 2^128`.
    fn vested_at(&self, now: u64) -> u128 {
        if now <= self.start {
            return 0;
        }
        if now >= self.stop {
            return self.deposit;
        }
        let duration = u128::from(self.stop - self.start);
        let elapsed = u128::from(now - self.start);
        (self.deposit / duration) * elapsed + (self.deposit % duration) * elapsed / duration
    }

    fn withdrawable_at(&self, now: u64) -> u128 {
        self.vested_at(now) - self.withdrawn
    }
}

/// One stream to create, as listed in the `ft_transfer_call` msg.
#[near(serializers = [json])]
pub struct StreamRequest {
    pub worker: AccountId,
    pub amount: U128,
    pub start: u64,
    pub stop: u64,
}

/// The JSON `msg` an employer passes to `ft_transfer_call`.
#[near(serializers = [json])]
pub struct FundingMsg {
    pub streams: Vec<StreamRequest>,
}

#[near(serializers = [json])]
pub struct StreamView {
    pub id: u64,
    pub employer: AccountId,
    pub worker: AccountId,
    pub deposit: U128,
    pub withdrawn: U128,
    pub withdrawable: U128,
    pub start: u64,
    pub stop: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Payday {
    token: AccountId,
    next_id: u64,
    streams: LookupMap<u64, Stream>,
    by_account: LookupMap<AccountId, Vec<u64>>,
    owed: LookupMap<AccountId, u128>,
}

#[near]
impl Payday {
    #[init]
    pub fn new(token: AccountId) -> Self {
        Self {
            token,
            next_id: 1,
            streams: LookupMap::new(StorageKey::Streams),
            by_account: LookupMap::new(StorageKey::ByAccount),
            owed: LookupMap::new(StorageKey::Owed),
        }
    }

    /// NEP-141 receiver. Creates every stream in `msg`; panicking refunds the whole
    /// transfer, so a batch either fully succeeds or leaves no trace.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token,
            "Only the configured USDC token is accepted"
        );
        let funding: FundingMsg = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("Invalid funding msg"));
        let count = funding.streams.len();
        require!(count > 0, "No streams in msg");
        require!(count <= MAX_BATCH, "Too many streams in one transfer");

        let total = funding
            .streams
            .iter()
            .try_fold(0u128, |acc, s| acc.checked_add(s.amount.0))
            .unwrap_or_else(|| env::panic_str("Stream amounts overflow"));
        require!(
            total == amount.0,
            "Stream amounts must add up to the amount sent"
        );

        let now = now_secs();
        let contract = env::current_account_id();
        for req in funding.streams {
            require!(req.worker != sender_id, "Worker cannot be the employer");
            require!(req.worker != contract, "Worker cannot be this contract");
            require!(
                req.amount.0 >= MIN_STREAM_AMOUNT,
                "Stream amount below minimum"
            );
            require!(req.stop > req.start, "Stop must be after start");
            require!(req.stop > now, "Stop must be in the future");

            let id = self.next_id;
            self.next_id += 1;
            let stream = Stream {
                employer: sender_id.clone(),
                worker: req.worker,
                deposit: req.amount.0,
                withdrawn: 0,
                start: req.start,
                stop: req.stop,
            };
            self.index_add(&stream.employer, id);
            self.index_add(&stream.worker, id);
            emit(
                "stream_created",
                json!({
                    "id": id,
                    "employer": stream.employer,
                    "worker": stream.worker,
                    "deposit": U128(stream.deposit),
                    "start": stream.start,
                    "stop": stream.stop,
                }),
            );
            self.streams.insert(id, stream);
        }
        PromiseOrValue::Value(U128(0))
    }

    /// Withdraws vested USDC. `amount` defaults to everything withdrawable.
    /// `receiver` defaults to the worker; pass a 1Click deposit address to cash out
    /// cross-chain. Attach at least 30 Tgas.
    pub fn withdraw(
        &mut self,
        stream_id: u64,
        amount: Option<U128>,
        receiver: Option<AccountId>,
    ) -> Promise {
        let worker = env::predecessor_account_id();
        let stream = self
            .streams
            .get_mut(&stream_id)
            .unwrap_or_else(|| env::panic_str("Stream not found"));
        require!(stream.worker == worker, "Only the worker can withdraw");

        let withdrawable = stream.withdrawable_at(now_secs());
        let amount = amount.map_or(withdrawable, |a| a.0);
        require!(amount > 0, "Nothing to withdraw");
        require!(
            amount <= withdrawable,
            "Amount exceeds withdrawable balance"
        );
        stream.withdrawn += amount;

        let receiver = receiver.unwrap_or_else(|| worker.clone());
        self.transfer(receiver.clone(), amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_withdraw(stream_id, worker, receiver, U128(amount)),
        )
    }

    /// Cancels a stream that has not finished. The employer is refunded the unvested
    /// part; the worker's vested-but-unclaimed part stays withdrawable. Cancelling never
    /// pushes funds to the worker, so a worker who cannot receive cannot block the
    /// employer's refund.
    pub fn cancel(&mut self, stream_id: u64) -> PromiseOrValue<bool> {
        let caller = env::predecessor_account_id();
        let now = now_secs();
        let stream = self
            .streams
            .get(&stream_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Stream not found"));
        require!(
            caller == stream.employer || caller == stream.worker,
            "Only the employer or worker can cancel"
        );
        require!(now < stream.stop, "Stream already ended");

        let vested = stream.vested_at(now);
        let refund = stream.deposit - vested;
        let worker_remaining = vested - stream.withdrawn;

        if worker_remaining == 0 {
            self.remove_stream(stream_id, &stream);
        } else {
            let s = self.streams.get_mut(&stream_id).expect("checked above");
            s.deposit = vested;
            s.stop = now;
        }
        emit(
            "stream_canceled",
            json!({
                "id": stream_id,
                "canceled_by": caller,
                "employer_refund": U128(refund),
                "worker_remaining": U128(worker_remaining),
            }),
        );

        if refund == 0 {
            return PromiseOrValue::Value(true);
        }
        PromiseOrValue::Promise(self.transfer_or_owe(stream.employer, refund))
    }

    /// Sends the caller any balance left over from failed transfers.
    pub fn claim_owed(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let amount = self.owed.remove(&account).unwrap_or(0);
        require!(amount > 0, "Nothing owed");
        self.transfer_or_owe(account, amount)
    }

    #[private]
    pub fn on_withdraw(
        &mut self,
        stream_id: u64,
        worker: AccountId,
        receiver: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            emit(
                "withdrawn",
                json!({"id": stream_id, "worker": worker, "receiver": receiver, "amount": amount}),
            );
            return true;
        }
        match self.streams.get_mut(&stream_id) {
            Some(stream) => stream.withdrawn -= amount.0,
            None => self.credit_owed(&worker, amount.0),
        }
        emit(
            "withdraw_failed",
            json!({"id": stream_id, "worker": worker, "receiver": receiver, "amount": amount}),
        );
        false
    }

    #[private]
    pub fn on_transfer_or_owe(
        &mut self,
        account: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        self.credit_owed(&account, amount.0);
        emit(
            "transfer_failed",
            json!({"account": account, "amount": amount}),
        );
        false
    }

    // ---------- views ----------

    pub fn token(&self) -> &AccountId {
        &self.token
    }

    pub fn get_stream(&self, stream_id: u64) -> Option<StreamView> {
        let now = now_secs();
        self.streams
            .get(&stream_id)
            .map(|s| view(stream_id, s, now))
    }

    /// Every live stream where `account_id` is the employer or the worker.
    pub fn streams_of(&self, account_id: AccountId) -> Vec<StreamView> {
        let now = now_secs();
        self.by_account
            .get(&account_id)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| self.streams.get(id).map(|s| view(*id, s, now)))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn owed_of(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).copied().unwrap_or(0))
    }
}

impl Payday {
    fn transfer(&self, receiver: AccountId, amount: u128) -> Promise {
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(receiver, U128(amount), Some("Payday".to_string()))
    }

    fn transfer_or_owe(&self, account: AccountId, amount: u128) -> Promise {
        self.transfer(account.clone(), amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_transfer_or_owe(account, U128(amount)),
        )
    }

    fn credit_owed(&mut self, account: &AccountId, amount: u128) {
        let balance = self.owed.entry(account.clone()).or_insert(0);
        *balance += amount;
    }

    fn index_add(&mut self, account: &AccountId, id: u64) {
        self.by_account.entry(account.clone()).or_default().push(id);
    }

    fn index_remove(&mut self, account: &AccountId, id: u64) {
        if let Some(ids) = self.by_account.get_mut(account) {
            ids.retain(|x| *x != id);
            if ids.is_empty() {
                self.by_account.remove(account);
            }
        }
    }

    fn remove_stream(&mut self, id: u64, stream: &Stream) {
        self.streams.remove(&id);
        self.index_remove(&stream.employer, id);
        self.index_remove(&stream.worker, id);
    }
}

fn now_secs() -> u64 {
    env::block_timestamp() / NANOS_PER_SEC
}

fn view(id: u64, s: &Stream, now: u64) -> StreamView {
    StreamView {
        id,
        employer: s.employer.clone(),
        worker: s.worker.clone(),
        deposit: U128(s.deposit),
        withdrawn: U128(s.withdrawn),
        withdrawable: U128(s.withdrawable_at(now)),
        start: s.start,
        stop: s.stop,
    }
}

/// NEP-297 event log.
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "payday", "version": "1.0.0", "event": event, "data": [data]})
    ));
}
