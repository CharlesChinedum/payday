//! Payday: per-second USDC payroll streams on NEAR.
//!
//! An employer funds one or more streams in a single `ft_transfer_call` on the USDC
//! contract. Each stream vests linearly from `start` to `stop` (Unix seconds). The worker
//! withdraws whatever has vested, to their own account or to any account they name (for
//! example a NEAR Intents 1Click deposit address for cross-chain cash-out). Either party
//! can cancel: the employer is refunded the unvested part and the worker keeps the rest.
//!
//! **Who pays for what.** This contract never spends its own NEAR for free on a caller's
//! behalf. Funding pays a small USDC fee per stream. Every payout first asks the token
//! whether the receiver is registered; only if it is not does Payday register it, and it
//! then deducts a one-time USDC registration fee from that payout. Registrations are
//! refused below a NEAR reserve, so a drained contract fails payouts safely instead of
//! losing track of money. Fees accrue to the owner, who uses them to keep the account
//! funded.
//!
//! **Async safety.** Every outgoing transfer updates the books first and reconciles in a
//! callback. A failed payout is credited back to its stream, or to the account's `owed`
//! balance when the stream is gone (see `claim_owed`).
//!
//! **Storage.** Streams are deleted once fully paid out, dust left by a cancel moves to
//! `owed`, and `prune` lets anyone delete settled streams. Funding is refused if it would
//! eat into the NEAR reserve that callbacks rely on.

use near_sdk::borsh::BorshDeserialize;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

#[cfg(test)]
mod tests;

pub const VERSION: &str = "2.2.0";

/// 1 USDC (6 decimals): the smallest stream, and the smallest payout to another account.
pub const MIN_STREAM_AMOUNT: u128 = 1_000_000;
/// Maximum streams created by one funding transfer.
pub const MAX_BATCH: usize = 25;
/// Fees the owner can set, each between 0.001 and 1 USDC. A floor above zero keeps every
/// sponsored action and every registration paid for.
pub const MIN_FEE: u128 = 1_000;
pub const MAX_FEE: u128 = 1_000_000;
/// Default fees: 0.01 USDC each.
pub const DEFAULT_STREAM_FEE: u128 = 10_000;
pub const DEFAULT_REGISTRATION_FEE: u128 = 10_000;
pub const DEFAULT_PAYOUT_FEE: u128 = 10_000;
/// A stream may start at most this far in the past or the future, and last at most
/// `MAX_DURATION_SECS`. Catches milliseconds passed as seconds.
pub const MAX_START_OFFSET_SECS: u64 = 366 * 86_400;
pub const MAX_DURATION_SECS: u64 = 5 * 366 * 86_400;
/// `streams_of` page size.
pub const DEFAULT_PAGE: u32 = 50;
pub const MAX_PAGE: u32 = 100;
pub const MAX_PRUNE: usize = 50;
/// NEP-145 registration cost on Circle USDC and the NEAR standard token (125 bytes).
pub const REGISTRATION_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// NEAR kept free beyond storage so callbacks can always record what they owe.
pub const NEAR_RESERVE: NearToken = NearToken::from_millinear(250);
/// Storage of one `registered` entry, excluding the account id: key prefix, length, overhead.
const REGISTERED_ENTRY_BYTES: u128 = 45;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_STORAGE_VIEW: Gas = Gas::from_tgas(5);
const GAS_ON_PAID: Gas = Gas::from_tgas(15);
/// Covers its own work plus the registration, transfer and `on_paid` it schedules.
const GAS_ROUTE: Gas = Gas::from_tgas(60);
const GAS_MIGRATE: Gas = Gas::from_tgas(50);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NANOS_PER_SEC: u64 = 1_000_000_000;
const STORAGE_VIEW_MAX_BYTES: usize = 1_024;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn storage_balance_of(&self, account_id: AccountId);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Streams,
    ByAccount,
    Owed,
    Registered,
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

    fn is_settled(&self, now: u64) -> bool {
        now >= self.stop && self.withdrawn == self.deposit
    }
}

/// Where a payout's money comes from, and so where it goes back to if the payout fails.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// Vested salary from a stream; restored to the stream, or to `owed` if it is gone.
    Stream { id: u64 },
    /// A balance held for an account (cancel refunds, dust, sends, failed payouts).
    Owed,
    /// Collected fees, paid out to the owner's chosen receiver.
    Fees,
}

/// One stream to create, as listed in the `ft_transfer_call` msg.
#[near(serializers = [json])]
pub struct StreamRequest {
    pub worker: AccountId,
    pub amount: U128,
    pub start: u64,
    pub stop: u64,
}

/// The JSON `msg` passed to `ft_transfer_call`: either `{"streams": [...]}` to fund
/// payroll, or `{"send_to": "account"}` to pass USDC on through Payday, which registers
/// the receiver if needed for the registration fee.
#[near(serializers = [json])]
pub struct TransferMsg {
    pub streams: Option<Vec<StreamRequest>>,
    pub send_to: Option<AccountId>,
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

#[near(serializers = [json])]
pub struct ConfigView {
    pub version: String,
    pub token: AccountId,
    pub owner: AccountId,
    pub proposed_owner: Option<AccountId>,
    pub paused: bool,
    pub stream_fee: U128,
    pub registration_fee: U128,
    pub payout_fee: U128,
    pub fees_collected: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Payday {
    token: AccountId,
    owner: AccountId,
    proposed_owner: Option<AccountId>,
    paused: bool,
    stream_fee: u128,
    registration_fee: u128,
    /// Charged on every withdrawal, claim and send: it pays for the gas the relayer
    /// spends on the user's behalf, so no sponsored payout is free to repeat.
    payout_fee: u128,
    fees_collected: u128,
    next_id: u64,
    streams: LookupMap<u64, Stream>,
    by_account: LookupMap<AccountId, Vec<u64>>,
    owed: LookupMap<AccountId, u128>,
    /// Accounts Payday has paid a USDC registration for. Circle's USDC refunds the
    /// registration deposit to the account itself when it unregisters, so paying twice
    /// for one account would let it farm the deposit (I-07).
    registered: LookupSet<AccountId>,
}

/// State layout of version 2.0.0.
#[derive(BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct PaydayV2 {
    token: AccountId,
    owner: AccountId,
    proposed_owner: Option<AccountId>,
    paused: bool,
    stream_fee: u128,
    registration_fee: u128,
    payout_fee: u128,
    fees_collected: u128,
    next_id: u64,
    streams: LookupMap<u64, Stream>,
    by_account: LookupMap<AccountId, Vec<u64>>,
    owed: LookupMap<AccountId, u128>,
}

/// State layout of version 1.0.0, kept so `migrate` can upgrade a live deployment.
#[derive(BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
struct PaydayV1 {
    token: AccountId,
    next_id: u64,
    streams: LookupMap<u64, Stream>,
    by_account: LookupMap<AccountId, Vec<u64>>,
    owed: LookupMap<AccountId, u128>,
}

#[near]
impl Payday {
    #[init]
    #[private]
    pub fn new(token: AccountId, owner: AccountId) -> Self {
        Self {
            token,
            owner,
            proposed_owner: None,
            paused: false,
            stream_fee: DEFAULT_STREAM_FEE,
            registration_fee: DEFAULT_REGISTRATION_FEE,
            payout_fee: DEFAULT_PAYOUT_FEE,
            fees_collected: 0,
            next_id: 1,
            streams: LookupMap::new(StorageKey::Streams),
            by_account: LookupMap::new(StorageKey::ByAccount),
            owed: LookupMap::new(StorageKey::Owed),
            registered: LookupSet::new(StorageKey::Registered),
        }
    }

    /// Re-reads state after a code upgrade. Accepts the current layout unchanged, the
    /// 2.0.0 layout, or the 1.0.0 layout, which needs `owner`.
    #[init(ignore_state)]
    #[private]
    pub fn migrate(owner: Option<AccountId>) -> Self {
        let bytes = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("No state"));
        if let Ok(current) = near_sdk::borsh::from_slice::<Payday>(&bytes) {
            return current;
        }
        if let Ok(v2) = near_sdk::borsh::from_slice::<PaydayV2>(&bytes) {
            return Self {
                token: v2.token,
                owner: v2.owner,
                proposed_owner: v2.proposed_owner,
                paused: v2.paused,
                stream_fee: v2.stream_fee,
                registration_fee: v2.registration_fee,
                payout_fee: v2.payout_fee,
                fees_collected: v2.fees_collected,
                next_id: v2.next_id,
                streams: v2.streams,
                by_account: v2.by_account,
                owed: v2.owed,
                registered: LookupSet::new(StorageKey::Registered),
            };
        }
        let old = near_sdk::borsh::from_slice::<PaydayV1>(&bytes)
            .unwrap_or_else(|_| env::panic_str("Unrecognised state layout"));
        Self {
            token: old.token,
            owner: owner.unwrap_or_else(|| env::panic_str("Migrating 1.0.0 needs an owner")),
            proposed_owner: None,
            paused: false,
            stream_fee: DEFAULT_STREAM_FEE,
            registration_fee: DEFAULT_REGISTRATION_FEE,
            payout_fee: DEFAULT_PAYOUT_FEE,
            fees_collected: 0,
            next_id: old.next_id,
            streams: old.streams,
            by_account: old.by_account,
            owed: old.owed,
            registered: LookupSet::new(StorageKey::Registered),
        }
    }

    /// NEP-141 receiver. Funding creates every stream in `msg` and keeps the stream fees;
    /// panicking refunds the whole transfer, so a batch either fully succeeds or leaves
    /// no trace. `send_to` passes the USDC on (see `TransferMsg`).
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
        let parsed: TransferMsg =
            near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("Invalid msg"));
        match (parsed.streams, parsed.send_to) {
            (Some(streams), None) => self.fund(sender_id, amount.0, streams),
            (None, Some(receiver)) => self.send(sender_id, amount.0, receiver),
            _ => env::panic_str("msg needs exactly one of streams or send_to"),
        }
        // Always settle the transfer here: returning a promise would make the token
        // read its result as the unused amount.
        PromiseOrValue::Value(U128(0))
    }

    /// Withdraws vested USDC. `amount` defaults to everything withdrawable and must be at
    /// least 1 USDC unless it empties the stream. `receiver` defaults to the worker. The
    /// payout fee is deducted, plus the registration fee if the receiver is not
    /// registered with the token. Attach 100 Tgas.
    pub fn withdraw(
        &mut self,
        stream_id: u64,
        amount: Option<U128>,
        receiver: Option<AccountId>,
    ) -> Promise {
        let worker = env::predecessor_account_id();
        let receiver = receiver.unwrap_or_else(|| worker.clone());
        self.assert_valid_receiver(&receiver);
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
        let empties_stream = amount == stream.deposit - stream.withdrawn;
        require!(
            amount >= MIN_STREAM_AMOUNT || empties_stream,
            "Withdraw at least 1 USDC, or everything left in the stream"
        );
        require!(
            amount > self.payout_fee,
            "Amount does not cover the payout fee"
        );
        stream.withdrawn += amount;
        let fee = self.payout_fee;
        self.payout(
            worker,
            receiver,
            amount,
            fee,
            Source::Stream { id: stream_id },
        )
    }

    /// Cancels a stream that has not finished. The employer is refunded the unvested
    /// part. The worker keeps the vested part: it stays in the stream, or, if it is less
    /// than 1 USDC, moves to the worker's `owed` balance so the stream can be deleted.
    /// Cancelling never pushes funds to the worker, so a worker who cannot receive
    /// cannot block the employer's refund.
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
        let worker_remaining_to = if worker_remaining >= MIN_STREAM_AMOUNT {
            let s = self.streams.get_mut(&stream_id).expect("checked above");
            s.deposit = vested;
            s.stop = now;
            "stream"
        } else {
            self.remove_stream(stream_id, &stream);
            if worker_remaining > 0 {
                self.credit_owed(&stream.worker, worker_remaining);
                "owed"
            } else {
                "none"
            }
        };
        emit(
            "stream_canceled",
            json!({
                "id": stream_id,
                "canceled_by": caller,
                "employer_refund": U128(refund),
                "worker_remaining": U128(worker_remaining),
                "worker_remaining_to": worker_remaining_to,
            }),
        );

        if refund == 0 {
            return PromiseOrValue::Value(true);
        }
        // The refund is the stream's own money returning: no payout fee.
        PromiseOrValue::Promise(self.payout(
            stream.employer.clone(),
            stream.employer,
            refund,
            0,
            Source::Owed,
        ))
    }

    /// Pays out the caller's `owed` balance, to themselves or (for 1 USDC or more) to
    /// another account, less the payout fee. Attach 100 Tgas.
    pub fn claim_owed(&mut self, receiver: Option<AccountId>) -> Promise {
        let account = env::predecessor_account_id();
        let receiver = receiver.unwrap_or_else(|| account.clone());
        self.assert_valid_receiver(&receiver);
        // The entry is zeroed, not removed: the payout below needs it if it fails.
        let amount = self.owed.get_mut(&account).map(std::mem::take).unwrap_or(0);
        require!(amount > 0, "Nothing owed");
        if receiver != account {
            require!(
                amount >= MIN_STREAM_AMOUNT,
                "Payouts to another account must be at least 1 USDC"
            );
        }
        require!(
            amount > self.payout_fee,
            "Owed balance does not cover the payout fee"
        );
        let fee = self.payout_fee;
        self.payout(account, receiver, amount, fee, Source::Owed)
    }

    /// Deletes streams that have ended and been fully paid out. Anyone may call it. A
    /// finished stream whose remainder is too small to pay its own payout fee can never be
    /// withdrawn or cancelled, so that remainder goes to fees and the stream is deleted too.
    pub fn prune(&mut self, stream_ids: Vec<u64>) -> u32 {
        require!(
            stream_ids.len() <= MAX_PRUNE,
            "Too many streams in one call"
        );
        let now = now_secs();
        let mut removed = 0;
        let fee = self.payout_fee;
        for id in stream_ids {
            let done = self
                .streams
                .get(&id)
                .filter(|s| now >= s.stop && s.deposit - s.withdrawn <= fee)
                .cloned();
            if let Some(stream) = done {
                let dust = stream.deposit - stream.withdrawn;
                self.fees_collected += dust;
                self.remove_stream(id, &stream);
                emit(
                    "stream_closed",
                    json!({ "id": id, "dust_to_fees": U128(dust) }),
                );
                removed += 1;
            }
        }
        removed
    }

    // ---------- owner ----------

    pub fn set_fees(&mut self, stream_fee: U128, registration_fee: U128, payout_fee: U128) {
        self.assert_owner();
        for fee in [stream_fee.0, registration_fee.0, payout_fee.0] {
            require!(
                (MIN_FEE..=MAX_FEE).contains(&fee),
                "Each fee must be between 0.001 and 1 USDC"
            );
        }
        self.stream_fee = stream_fee.0;
        self.registration_fee = registration_fee.0;
        self.payout_fee = payout_fee.0;
        emit(
            "fees_set",
            json!({ "stream_fee": stream_fee, "registration_fee": registration_fee, "payout_fee": payout_fee }),
        );
    }

    /// Blocks new funding only. Withdrawals, cancels, claims and sends keep working.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit("paused_set", json!({ "paused": paused }));
    }

    pub fn withdraw_fees(&mut self, amount: U128, receiver: AccountId) -> Promise {
        self.assert_owner();
        self.assert_valid_receiver(&receiver);
        require!(
            amount.0 > 0 && amount.0 <= self.fees_collected,
            "Amount exceeds collected fees"
        );
        self.fees_collected -= amount.0;
        self.payout(self.owner.clone(), receiver, amount.0, 0, Source::Fees)
    }

    /// First step of an ownership transfer; the new owner must call `accept_owner`.
    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.proposed_owner = Some(new_owner);
    }

    pub fn accept_owner(&mut self) {
        let caller = env::predecessor_account_id();
        require!(
            self.proposed_owner.as_ref() == Some(&caller),
            "Not the proposed owner"
        );
        self.owner = caller;
        self.proposed_owner = None;
        emit("owner_set", json!({ "owner": self.owner }));
    }

    /// Deploys new contract code passed as the raw call input, then runs `migrate`. Lets
    /// the account drop its full-access keys and be upgraded only through the owner.
    pub fn upgrade(&mut self) -> Promise {
        self.assert_owner();
        let code = env::input().unwrap_or_else(|| env::panic_str("Missing contract code"));
        require!(!code.is_empty(), "Missing contract code");
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call(
                "migrate".to_string(),
                br#"{"owner":null}"#.to_vec(),
                NearToken::from_yoctonear(0),
                GAS_MIGRATE,
            )
    }

    // ---------- callbacks ----------

    /// Second step of a payout: routes on whether the receiver is registered, adding the
    /// registration fee to `base_fee` only if Payday must register it. Fees are booked
    /// only once the transfer succeeds (`on_paid`), so nothing in flight can be withdrawn.
    #[private]
    pub fn on_receiver_checked(
        &mut self,
        account: AccountId,
        receiver: AccountId,
        amount: U128,
        base_fee: U128,
        source: Source,
    ) -> PromiseOrValue<bool> {
        let gross = amount.0;
        let Some(registered) = receiver_registration() else {
            return PromiseOrValue::Value(self.fail_payout(
                &account,
                &receiver,
                gross,
                source,
                "registration check failed",
            ));
        };
        if registered {
            if gross <= base_fee.0 {
                return PromiseOrValue::Value(self.fail_payout(
                    &account,
                    &receiver,
                    gross,
                    source,
                    "amount does not cover the fees",
                ));
            }
            return PromiseOrValue::Promise(
                self.transfer_then_settle(None, account, receiver, gross, base_fee.0, source),
            );
        }
        if self.registered.contains(&receiver) {
            return PromiseOrValue::Value(self.fail_payout(
                &account,
                &receiver,
                gross,
                source,
                "receiver is not registered with USDC and Payday already paid its registration once; register yourself first",
            ));
        }
        let fee = base_fee.0 + self.registration_fee;
        if gross <= fee {
            return PromiseOrValue::Value(self.fail_payout(
                &account,
                &receiver,
                gross,
                source,
                "amount does not cover the fees",
            ));
        }
        if !self.can_afford_registration(&receiver) {
            return PromiseOrValue::Value(self.fail_payout(
                &account,
                &receiver,
                gross,
                source,
                "registration unavailable, try again later",
            ));
        }
        // Recorded now: if the registration then fails, the account registers itself.
        self.registered.insert(receiver.clone());
        let register = ext_ft::ext(self.token.clone())
            .with_attached_deposit(REGISTRATION_DEPOSIT)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(receiver.clone()), Some(true));
        PromiseOrValue::Promise(self.transfer_then_settle(
            Some(register),
            account,
            receiver,
            gross,
            fee,
            source,
        ))
    }

    /// Last step of a payout: on success books the fee and records the payout (deleting a
    /// settled stream); on failure puts the whole amount back where it came from.
    #[private]
    pub fn on_paid(
        &mut self,
        account: AccountId,
        receiver: AccountId,
        amount: U128,
        fee: U128,
        source: Source,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            return self.fail_payout(
                &account,
                &receiver,
                amount.0,
                source,
                "token transfer failed",
            );
        }
        self.fees_collected += fee.0;
        emit(
            "paid",
            json!({
                "source": source,
                "account": account,
                "receiver": receiver,
                "amount": U128(amount.0 - fee.0),
                "fee": fee,
            }),
        );
        if let Source::Stream { id } = source {
            self.close_if_settled(id);
        }
        true
    }

    // ---------- 1.0 callbacks ----------
    // Transfers started by 1.0 that are still in flight when the contract is upgraded call
    // back into these. They settle exactly as 1.0 would have, so no payout is lost.

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
                json!({ "id": stream_id, "worker": worker, "receiver": receiver, "amount": amount }),
            );
            return true;
        }
        match self.streams.get_mut(&stream_id) {
            Some(stream) => stream.withdrawn -= amount.0,
            None => self.credit_owed(&worker, amount.0),
        }
        emit(
            "withdraw_failed",
            json!({ "id": stream_id, "worker": worker, "receiver": receiver, "amount": amount }),
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
            json!({ "account": account, "amount": amount }),
        );
        false
    }

    // ---------- views ----------

    pub fn config(&self) -> ConfigView {
        ConfigView {
            version: VERSION.to_string(),
            token: self.token.clone(),
            owner: self.owner.clone(),
            proposed_owner: self.proposed_owner.clone(),
            paused: self.paused,
            stream_fee: U128(self.stream_fee),
            registration_fee: U128(self.registration_fee),
            payout_fee: U128(self.payout_fee),
            fees_collected: U128(self.fees_collected),
        }
    }

    pub fn get_stream(&self, stream_id: u64) -> Option<StreamView> {
        let now = now_secs();
        self.streams
            .get(&stream_id)
            .map(|s| view(stream_id, s, now))
    }

    /// Live streams where `account_id` is the employer or the worker, oldest first.
    pub fn streams_of(
        &self,
        account_id: AccountId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<StreamView> {
        let now = now_secs();
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE) as usize;
        self.by_account
            .get(&account_id)
            .map(|ids| {
                ids.iter()
                    .skip(from)
                    .take(limit)
                    .filter_map(|id| self.streams.get(id).map(|s| view(*id, s, now)))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn stream_count_of(&self, account_id: AccountId) -> u32 {
        self.by_account
            .get(&account_id)
            .map_or(0, |ids| ids.len() as u32)
    }

    pub fn owed_of(&self, account_id: AccountId) -> U128 {
        U128(self.owed.get(&account_id).copied().unwrap_or(0))
    }
}

impl Payday {
    fn fund(&mut self, employer: AccountId, amount: u128, requests: Vec<StreamRequest>) {
        require!(!self.paused, "Funding is paused");
        let count = requests.len();
        require!(count > 0, "No streams in msg");
        require!(count <= MAX_BATCH, "Too many streams in one transfer");

        let fees = self.stream_fee * count as u128;
        let total = requests
            .iter()
            .try_fold(fees, |acc, s| acc.checked_add(s.amount.0))
            .unwrap_or_else(|| env::panic_str("Stream amounts overflow"));
        require!(
            total == amount,
            "Amount sent must equal the stream amounts plus the stream fees"
        );

        let now = now_secs();
        for req in requests {
            self.assert_valid_stream(&employer, &req, now);
            let id = self.next_id;
            self.next_id += 1;
            let stream = Stream {
                employer: employer.clone(),
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
                    "fee": U128(self.stream_fee),
                    "start": stream.start,
                    "stop": stream.stop,
                }),
            );
            self.streams.insert(id, stream);
        }
        self.fees_collected += fees;
        // Collections write on flush; flush now so the check sees the new streams.
        self.streams.flush();
        self.by_account.flush();
        require!(
            self.free_near() >= NEAR_RESERVE.as_yoctonear(),
            "Payday is at storage capacity; try again later"
        );
    }

    fn send(&mut self, sender: AccountId, amount: u128, receiver: AccountId) {
        self.assert_valid_receiver(&receiver);
        require!(receiver != sender, "Cannot send to yourself");
        require!(amount >= MIN_STREAM_AMOUNT, "Sends must be at least 1 USDC");
        require!(
            amount > self.payout_fee,
            "Amount does not cover the payout fee"
        );
        // Detached: the transfer has settled; a failed payout lands in the sender's owed.
        let fee = self.payout_fee;
        self.payout(sender, receiver, amount, fee, Source::Owed)
            .detach();
    }

    /// Pays `amount` from `source` to `receiver`, less `base_fee` (and the registration
    /// fee if needed), crediting `account` if it fails.
    ///
    /// A failed payout may have to credit `account`'s `owed` balance, and the callback
    /// that does it cannot be allowed to need new storage: if Payday could not pay for it,
    /// the callback would fail and the amount would be recorded nowhere (review 3, M-1).
    /// So the entry is created here, while the reserve can still be checked, and kept.
    fn payout(
        &mut self,
        account: AccountId,
        receiver: AccountId,
        amount: u128,
        base_fee: u128,
        source: Source,
    ) -> Promise {
        if source != Source::Fees && !self.owed.contains_key(&account) {
            self.owed.insert(account.clone(), 0);
            self.owed.flush();
            require!(
                self.free_near() >= NEAR_RESERVE.as_yoctonear(),
                "Payday is at storage capacity; try again later"
            );
        }
        ext_ft::ext(self.token.clone())
            .with_static_gas(GAS_STORAGE_VIEW)
            .storage_balance_of(receiver.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ROUTE)
                    .on_receiver_checked(account, receiver, U128(amount), U128(base_fee), source),
            )
    }

    /// Transfers the net amount, then settles in `on_paid`. `after` (a registration) runs
    /// first if given. NEAR cannot chain a promise that already has a callback, so the
    /// steps are joined as `after.then(transfer).then(on_paid)`.
    fn transfer_then_settle(
        &self,
        after: Option<Promise>,
        account: AccountId,
        receiver: AccountId,
        gross: u128,
        fee: u128,
        source: Source,
    ) -> Promise {
        let transfer = ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                receiver.clone(),
                U128(gross - fee),
                Some("Payday".to_string()),
            );
        let settle = Self::ext(env::current_account_id())
            .with_static_gas(GAS_ON_PAID)
            .on_paid(account, receiver, U128(gross), U128(fee), source);
        match after {
            Some(first) => first.then(transfer).then(settle),
            None => transfer.then(settle),
        }
    }

    /// Puts a failed payout's whole amount back where it came from. No fee was booked yet,
    /// so there is nothing to take back from `fees_collected`.
    fn fail_payout(
        &mut self,
        account: &AccountId,
        receiver: &AccountId,
        gross: u128,
        source: Source,
        reason: &str,
    ) -> bool {
        let credited_to = match source {
            Source::Stream { id } => match self.streams.get_mut(&id) {
                Some(stream) => {
                    stream.withdrawn -= gross;
                    "stream"
                }
                None => {
                    self.credit_owed(account, gross);
                    "owed"
                }
            },
            Source::Owed => {
                self.credit_owed(account, gross);
                "owed"
            }
            Source::Fees => {
                self.fees_collected += gross;
                "fees"
            }
        };
        emit(
            "payout_failed",
            json!({
                "source": source,
                "account": account,
                "receiver": receiver,
                "amount": U128(gross),
                "credited_to": credited_to,
                "reason": reason,
            }),
        );
        false
    }

    fn close_if_settled(&mut self, id: u64) {
        let settled = self
            .streams
            .get(&id)
            .filter(|s| s.is_settled(now_secs()))
            .cloned();
        if let Some(stream) = settled {
            self.remove_stream(id, &stream);
            emit("stream_closed", json!({ "id": id }));
        }
    }

    fn free_near(&self) -> u128 {
        let locked = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        env::account_balance().as_yoctonear().saturating_sub(locked)
    }

    /// Room for the registration deposit and for the `registered` entry it adds, above the reserve.
    fn can_afford_registration(&self, receiver: &AccountId) -> bool {
        let entry = (REGISTERED_ENTRY_BYTES + receiver.len() as u128)
            * env::storage_byte_cost().as_yoctonear();
        self.free_near()
            >= NEAR_RESERVE.as_yoctonear() + REGISTRATION_DEPOSIT.as_yoctonear() + entry
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner"
        );
    }

    fn assert_valid_receiver(&self, receiver: &AccountId) {
        require!(
            *receiver != env::current_account_id() && *receiver != self.token,
            "Invalid receiver"
        );
    }

    fn assert_valid_stream(&self, employer: &AccountId, req: &StreamRequest, now: u64) {
        require!(req.worker != *employer, "Worker cannot be the employer");
        self.assert_valid_receiver(&req.worker);
        require!(
            req.amount.0 >= MIN_STREAM_AMOUNT,
            "Stream amount below minimum"
        );
        require!(req.stop > req.start, "Stop must be after start");
        require!(req.stop > now, "Stop must be in the future");
        require!(
            req.start.abs_diff(now) <= MAX_START_OFFSET_SECS,
            "Start must be within a year of now (in seconds, not milliseconds)"
        );
        require!(
            req.stop - req.start <= MAX_DURATION_SECS,
            "Stream longer than 5 years"
        );
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

/// Reads the `storage_balance_of` result without trusting its shape: `null` means not
/// registered, any other value means registered, and a failed call means unknown.
/// Parsing it by hand avoids a deserialisation panic that would strand the payout.
fn receiver_registration() -> Option<bool> {
    if env::promise_results_count() != 1 {
        return None;
    }
    match env::promise_result_checked(0, STORAGE_VIEW_MAX_BYTES) {
        Ok(bytes) => Some(bytes.trim_ascii() != b"null"),
        Err(PromiseError::TooLong(_)) => Some(true),
        Err(_) => None,
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
        json!({"standard": "payday", "version": VERSION, "event": event, "data": [data]})
    ));
}
