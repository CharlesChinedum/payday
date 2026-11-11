#![allow(unused_must_use)] // unit tests never execute returned promises
use super::*;
use near_sdk::borsh::BorshSerialize;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const USDC: &str = "usdc.testnet";
const CONTRACT: &str = "payday.testnet";
const OWNER: &str = "owner.testnet";
const EMPLOYER: &str = "acme.testnet";
const ALICE: &str = "alice.testnet";
const BOB: &str = "bob.testnet";

const START: u64 = 1_000_000;
const STOP: u64 = START + 1_000;
const DEPOSIT: u128 = 1_000 * MIN_STREAM_AMOUNT; // 1,000 USDC over 1,000 s
const FEE: u128 = DEFAULT_STREAM_FEE;
const REG_FEE: u128 = DEFAULT_REGISTRATION_FEE;
const RICH: u128 = 10u128.pow(26);
/// Storage the mock VM reports by default.
const MOCK_STORAGE_BYTES: u128 = 1024 * 300;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, now_secs: u64, balance: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(now_secs * NANOS_PER_SEC)
        .account_balance(NearToken::from_yoctonear(balance));
    b
}

fn set_ctx(predecessor: &str, now_secs: u64) {
    testing_env!(ctx(predecessor, now_secs, RICH).build());
}

fn set_callback(now_secs: u64, balance: u128, result: PromiseResult) {
    testing_env!(
        ctx(CONTRACT, now_secs, balance).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn just_above_storage() -> u128 {
    MOCK_STORAGE_BYTES * env::storage_byte_cost().as_yoctonear() + NEAR_RESERVE.as_yoctonear()
}

fn registered() -> PromiseResult {
    PromiseResult::Successful(br#"{"total":"1250000000000000000000","available":"0"}"#.to_vec())
}

fn unregistered() -> PromiseResult {
    PromiseResult::Successful(b"null".to_vec())
}

fn streams_msg(streams: &[(&str, u128, u64, u64)]) -> String {
    let list: Vec<_> = streams
        .iter()
        .map(|(w, a, s, e)| json!({"worker": w, "amount": a.to_string(), "start": s, "stop": e}))
        .collect();
    json!({ "streams": list }).to_string()
}

fn new_contract() -> Payday {
    set_ctx(CONTRACT, START);
    Payday::new(acc(USDC), acc(OWNER))
}

fn fund(c: &mut Payday, streams: &[(&str, u128, u64, u64)]) {
    set_ctx(USDC, START);
    let total = streams.iter().map(|s| s.1).sum::<u128>() + FEE * streams.len() as u128;
    let res = c.ft_on_transfer(acc(EMPLOYER), U128(total), streams_msg(streams));
    assert!(matches!(res, PromiseOrValue::Value(U128(0))));
}

/// Contract with one stream (id 1): EMPLOYER -> ALICE, DEPOSIT over START..STOP.
fn setup() -> Payday {
    let mut c = new_contract();
    fund(&mut c, &[(ALICE, DEPOSIT, START, STOP)]);
    c
}

fn stream(c: &Payday, id: u64) -> StreamView {
    c.get_stream(id).expect("stream exists")
}

fn events(name: &str) -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(j).unwrap())
        .filter(|e| e["event"] == name)
        .map(|e| e["data"][0].clone())
        .collect()
}

fn from_stream(id: u64) -> Source {
    Source::Stream { id }
}

// ---------- funding ----------

#[test]
fn funding_creates_streams_and_keeps_the_fees() {
    let mut c = new_contract();
    fund(
        &mut c,
        &[
            (ALICE, DEPOSIT, START, STOP),
            (BOB, 2 * DEPOSIT, START, STOP),
        ],
    );

    assert_eq!(stream(&c, 1).worker, acc(ALICE));
    assert_eq!(stream(&c, 2).deposit.0, 2 * DEPOSIT);
    assert_eq!(c.config().fees_collected.0, 2 * FEE);
    assert_eq!(c.stream_count_of(acc(EMPLOYER)), 2);
    assert_eq!(c.streams_of(acc(BOB), None, None).len(), 1);
    assert_eq!(events("stream_created").len(), 2);
}

#[test]
fn funding_spends_no_contract_near() {
    let mut c = new_contract();
    fund(&mut c, &[(ALICE, DEPOSIT, START, STOP)]);
    assert!(
        get_created_receipts().is_empty(),
        "no registration at funding"
    );
}

#[test]
#[should_panic(expected = "Amount sent must equal the stream amounts plus the stream fees")]
fn funding_rejects_a_total_without_fees() {
    let mut c = new_contract();
    set_ctx(USDC, START);
    c.ft_on_transfer(
        acc(EMPLOYER),
        U128(DEPOSIT),
        streams_msg(&[(ALICE, DEPOSIT, START, STOP)]),
    );
}

#[test]
#[should_panic(expected = "Only the configured USDC token is accepted")]
fn funding_rejects_other_tokens() {
    let mut c = new_contract();
    set_ctx("fake-usdc.testnet", START);
    c.ft_on_transfer(
        acc(EMPLOYER),
        U128(DEPOSIT + FEE),
        streams_msg(&[(ALICE, DEPOSIT, START, STOP)]),
    );
}

#[test]
#[should_panic(expected = "Stream amount below minimum")]
fn funding_rejects_dust_streams() {
    let mut c = new_contract();
    fund(&mut c, &[(ALICE, MIN_STREAM_AMOUNT - 1, START, STOP)]);
}

#[test]
#[should_panic(expected = "Worker cannot be the employer")]
fn funding_rejects_self_stream() {
    let mut c = new_contract();
    fund(&mut c, &[(EMPLOYER, DEPOSIT, START, STOP)]);
}

#[test]
#[should_panic(expected = "Invalid receiver")]
fn funding_rejects_the_token_as_worker() {
    let mut c = new_contract();
    fund(&mut c, &[(USDC, DEPOSIT, START, STOP)]);
}

#[test]
#[should_panic(expected = "Start must be within a year of now")]
fn funding_rejects_milliseconds() {
    let mut c = new_contract();
    let ms = START * 1000;
    fund(&mut c, &[(ALICE, DEPOSIT, ms, ms + 1000)]);
}

#[test]
#[should_panic(expected = "Stream longer than 5 years")]
fn funding_rejects_endless_streams() {
    let mut c = new_contract();
    fund(&mut c, &[(ALICE, DEPOSIT, START, u64::MAX)]);
}

#[test]
#[should_panic(expected = "Too many streams in one transfer")]
fn funding_rejects_oversized_batch() {
    let mut c = new_contract();
    let workers: Vec<String> = (0..=MAX_BATCH).map(|i| format!("w{i}.testnet")).collect();
    let streams: Vec<_> = workers
        .iter()
        .map(|w| (w.as_str(), MIN_STREAM_AMOUNT, START, STOP))
        .collect();
    fund(&mut c, &streams);
}

#[test]
#[should_panic(expected = "Funding is paused")]
fn funding_respects_pause() {
    let mut c = new_contract();
    set_ctx(OWNER, START);
    c.set_paused(true);
    fund(&mut c, &[(ALICE, DEPOSIT, START, STOP)]);
}

#[test]
#[should_panic(expected = "Payday is at storage capacity")]
fn funding_refuses_to_eat_the_near_reserve() {
    let mut c = new_contract();
    testing_env!(ctx(USDC, START, just_above_storage()).build());
    c.ft_on_transfer(
        acc(EMPLOYER),
        U128(DEPOSIT + FEE),
        streams_msg(&[(ALICE, DEPOSIT, START, STOP)]),
    );
}

#[test]
#[should_panic(expected = "msg needs exactly one of streams or send_to")]
fn msg_must_choose_one_action() {
    let mut c = new_contract();
    set_ctx(USDC, START);
    c.ft_on_transfer(
        acc(EMPLOYER),
        U128(DEPOSIT),
        r#"{"streams":[],"send_to":"bob.testnet"}"#.into(),
    );
}

// ---------- vesting maths ----------

#[test]
fn vesting_is_linear_and_capped() {
    let s = Stream {
        employer: acc(EMPLOYER),
        worker: acc(ALICE),
        deposit: DEPOSIT,
        withdrawn: 0,
        start: START,
        stop: STOP,
    };
    assert_eq!(s.vested_at(START - 1), 0);
    assert_eq!(s.vested_at(START + 250), DEPOSIT / 4);
    assert_eq!(s.vested_at(STOP), DEPOSIT);
    assert_eq!(s.vested_at(STOP + 10_000), DEPOSIT);
}

#[test]
fn vesting_does_not_overflow_on_huge_deposits() {
    let s = Stream {
        employer: acc(EMPLOYER),
        worker: acc(ALICE),
        deposit: u128::MAX,
        withdrawn: 0,
        start: 0,
        stop: u64::MAX,
    };
    let half = s.vested_at(u64::MAX / 2);
    assert!((u128::MAX / 2 - (1u128 << 65)..=u128::MAX / 2 + 1).contains(&half));
}

#[test]
fn vesting_matches_exact_formula_for_odd_numbers() {
    let s = Stream {
        employer: acc(EMPLOYER),
        worker: acc(ALICE),
        deposit: 1_234_567_891,
        withdrawn: 0,
        start: 7,
        stop: 7 + 997,
    };
    for e in [1u64, 13, 500, 996] {
        assert_eq!(s.vested_at(7 + e), 1_234_567_891u128 * u128::from(e) / 997);
    }
}

// ---------- withdraw ----------

#[test]
fn withdraw_books_the_amount_and_starts_a_payout() {
    let mut c = setup();
    set_ctx(ALICE, START + 250);
    c.withdraw(1, None, None);
    assert_eq!(stream(&c, 1).withdrawn.0, DEPOSIT / 4);
    assert_eq!(
        get_created_receipts().len(),
        2,
        "registration check, then routing"
    );
}

#[test]
#[should_panic(expected = "Only the worker can withdraw")]
fn only_worker_can_withdraw() {
    let mut c = setup();
    set_ctx(EMPLOYER, START + 500);
    c.withdraw(1, None, None);
}

#[test]
#[should_panic(expected = "Amount exceeds withdrawable balance")]
fn cannot_withdraw_more_than_vested() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, Some(U128(DEPOSIT / 2 + 1)), None);
}

#[test]
#[should_panic(expected = "Nothing to withdraw")]
fn cannot_withdraw_before_start() {
    let mut c = setup();
    set_ctx(ALICE, START);
    c.withdraw(1, None, None);
}

#[test]
#[should_panic(expected = "Payouts to another account must be at least 1 USDC")]
fn external_payout_has_a_minimum() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, Some(U128(MIN_STREAM_AMOUNT - 1)), Some(acc(BOB)));
}

#[test]
#[should_panic(expected = "Invalid receiver")]
fn cannot_pay_out_to_the_contract() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, Some(U128(MIN_STREAM_AMOUNT)), Some(acc(CONTRACT)));
}

// ---------- payout routing ----------

#[test]
fn registered_receiver_is_paid_without_a_fee() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_callback(START + 500, RICH, registered());
    let routed = c.on_receiver_checked(acc(ALICE), acc(ALICE), U128(DEPOSIT / 2), from_stream(1));
    assert!(matches!(routed, PromiseOrValue::Promise(_)));
    assert_eq!(c.config().fees_collected.0, FEE, "only the stream fee");
}

#[test]
fn unregistered_receiver_pays_the_registration_fee() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_callback(START + 500, RICH, unregistered());
    let routed = c.on_receiver_checked(acc(ALICE), acc(ALICE), U128(DEPOSIT / 2), from_stream(1));
    assert!(matches!(routed, PromiseOrValue::Promise(_)));
    assert_eq!(c.config().fees_collected.0, FEE + REG_FEE);
}

#[test]
fn registration_fee_must_fit_in_the_payout() {
    let mut c = setup();
    set_ctx(ALICE, START + 1);
    c.withdraw(1, Some(U128(REG_FEE)), None);
    set_callback(START + 1, RICH, unregistered());
    let routed = c.on_receiver_checked(acc(ALICE), acc(ALICE), U128(REG_FEE), from_stream(1));
    assert!(matches!(routed, PromiseOrValue::Value(false)));
    assert_eq!(stream(&c, 1).withdrawn.0, 0, "restored to the stream");
    assert_eq!(events("payout_failed")[0]["credited_to"], "stream");
}

#[test]
fn no_registration_below_the_near_reserve() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_callback(START + 500, just_above_storage(), unregistered());
    let routed = c.on_receiver_checked(acc(ALICE), acc(ALICE), U128(DEPOSIT / 2), from_stream(1));
    assert!(matches!(routed, PromiseOrValue::Value(false)));
    assert_eq!(stream(&c, 1).withdrawn.0, 0);
    assert_eq!(c.config().fees_collected.0, FEE, "no registration fee kept");
}

#[test]
fn failed_registration_check_restores_the_stream() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_callback(START + 500, RICH, PromiseResult::Failed);
    let routed = c.on_receiver_checked(acc(ALICE), acc(ALICE), U128(DEPOSIT / 2), from_stream(1));
    assert!(matches!(routed, PromiseOrValue::Value(false)));
    assert_eq!(stream(&c, 1).withdrawable.0, DEPOSIT / 2);
}

#[test]
fn unexpected_registration_reply_counts_as_registered() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_callback(
        START + 500,
        RICH,
        PromiseResult::Successful(b"\"surprise\"".to_vec()),
    );
    let routed = c.on_receiver_checked(acc(ALICE), acc(ALICE), U128(DEPOSIT / 2), from_stream(1));
    assert!(
        matches!(routed, PromiseOrValue::Promise(_)),
        "never panics, so a payout is never stranded"
    );
}

// ---------- settlement ----------

#[test]
fn successful_payout_reports_the_net_amount() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_callback(START + 500, RICH, PromiseResult::Successful(vec![]));
    assert!(c.on_paid(
        acc(ALICE),
        acc(ALICE),
        U128(DEPOSIT / 2),
        U128(REG_FEE),
        from_stream(1),
        Ok(())
    ));
    let paid = &events("paid")[0];
    assert_eq!(paid["amount"], (DEPOSIT / 2 - REG_FEE).to_string());
    assert_eq!(paid["fee"], REG_FEE.to_string());
    assert_eq!(paid["source"]["kind"], "stream");
}

#[test]
fn failed_transfer_restores_the_stream_and_refunds_the_fee() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_callback(START + 500, RICH, unregistered());
    c.on_receiver_checked(acc(ALICE), acc(ALICE), U128(DEPOSIT / 2), from_stream(1));
    assert_eq!(c.config().fees_collected.0, FEE + REG_FEE);

    set_callback(START + 500, RICH, PromiseResult::Failed);
    assert!(!c.on_paid(
        acc(ALICE),
        acc(ALICE),
        U128(DEPOSIT / 2),
        U128(REG_FEE),
        from_stream(1),
        Err(PromiseError::Failed)
    ));
    assert_eq!(stream(&c, 1).withdrawn.0, 0);
    assert_eq!(c.config().fees_collected.0, FEE);
}

#[test]
fn fully_paid_stream_is_deleted() {
    let mut c = setup();
    set_ctx(ALICE, STOP);
    c.withdraw(1, None, None);
    set_callback(STOP, RICH, PromiseResult::Successful(vec![]));
    c.on_paid(
        acc(ALICE),
        acc(ALICE),
        U128(DEPOSIT),
        U128(0),
        from_stream(1),
        Ok(()),
    );
    assert!(c.get_stream(1).is_none());
    assert_eq!(c.stream_count_of(acc(ALICE)), 0);
    assert_eq!(c.stream_count_of(acc(EMPLOYER)), 0);
    assert_eq!(events("stream_closed").len(), 1);
}

#[test]
fn failed_payout_after_deletion_goes_to_owed() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_ctx(EMPLOYER, START + 500);
    c.cancel(1); // nothing left for Alice in the stream, so it is deleted
    assert!(c.get_stream(1).is_none());

    set_callback(START + 500, RICH, PromiseResult::Failed);
    c.on_paid(
        acc(ALICE),
        acc(ALICE),
        U128(DEPOSIT / 2),
        U128(0),
        from_stream(1),
        Err(PromiseError::Failed),
    );
    assert_eq!(c.owed_of(acc(ALICE)).0, DEPOSIT / 2);
}

// ---------- cancel ----------

#[test]
fn cancel_refunds_the_employer_and_keeps_earned_salary_in_the_stream() {
    let mut c = setup();
    set_ctx(EMPLOYER, START + 250);
    assert!(matches!(c.cancel(1), PromiseOrValue::Promise(_)));
    let s = stream(&c, 1);
    assert_eq!(s.deposit.0, DEPOSIT / 4);
    assert_eq!(s.stop, START + 250);
    let e = &events("stream_canceled")[0];
    assert_eq!(e["employer_refund"], (DEPOSIT - DEPOSIT / 4).to_string());
    assert_eq!(e["worker_remaining_to"], "stream");
}

#[test]
fn cancel_before_anything_vests_deletes_the_stream() {
    let mut c = setup();
    set_ctx(EMPLOYER, START);
    c.cancel(1);
    assert!(c.get_stream(1).is_none());
    assert_eq!(c.stream_count_of(acc(ALICE)), 0);
    assert_eq!(events("stream_canceled")[0]["worker_remaining_to"], "none");
}

#[test]
fn cancel_moves_dust_to_owed_and_deletes_the_stream() {
    let mut c = setup();
    // One second in, exactly 1 USDC has vested; Alice takes 1 unit of it.
    set_ctx(ALICE, START + 1);
    c.withdraw(1, Some(U128(1)), None);
    set_ctx(EMPLOYER, START + 1);
    c.cancel(1);
    assert!(
        c.get_stream(1).is_none(),
        "a sub-1 USDC remainder does not keep the stream alive"
    );
    assert_eq!(c.owed_of(acc(ALICE)).0, MIN_STREAM_AMOUNT - 1);
    assert_eq!(events("stream_canceled")[0]["worker_remaining_to"], "owed");
}

#[test]
#[should_panic(expected = "Only the employer or worker can cancel")]
fn stranger_cannot_cancel() {
    let mut c = setup();
    set_ctx(BOB, START + 1);
    c.cancel(1);
}

#[test]
#[should_panic(expected = "Stream already ended")]
fn cannot_cancel_finished_stream() {
    let mut c = setup();
    set_ctx(EMPLOYER, STOP);
    c.cancel(1);
}

// ---------- owed ----------

#[test]
fn claim_owed_can_pay_another_account() {
    let mut c = setup();
    set_callback(START, RICH, PromiseResult::Failed);
    c.on_paid(
        acc(ALICE),
        acc(ALICE),
        U128(5 * MIN_STREAM_AMOUNT),
        U128(0),
        Source::Owed,
        Err(PromiseError::Failed),
    );
    assert_eq!(c.owed_of(acc(ALICE)).0, 5 * MIN_STREAM_AMOUNT);

    set_ctx(ALICE, START);
    c.claim_owed(Some(acc(BOB)));
    assert_eq!(c.owed_of(acc(ALICE)).0, 0);
    assert_eq!(get_created_receipts().len(), 2);
}

#[test]
#[should_panic(expected = "Payouts to another account must be at least 1 USDC")]
fn small_owed_balances_go_only_to_their_owner() {
    let mut c = setup();
    set_callback(START, RICH, PromiseResult::Failed);
    c.on_paid(
        acc(ALICE),
        acc(ALICE),
        U128(5),
        U128(0),
        Source::Owed,
        Err(PromiseError::Failed),
    );
    set_ctx(ALICE, START);
    c.claim_owed(Some(acc(BOB)));
}

#[test]
#[should_panic(expected = "Nothing owed")]
fn claim_owed_requires_balance() {
    let mut c = setup();
    set_ctx(BOB, START);
    c.claim_owed(None);
}

// ---------- send ----------

#[test]
fn send_passes_usdc_on_and_settles_the_transfer() {
    let mut c = new_contract();
    set_ctx(USDC, START);
    let res = c.ft_on_transfer(
        acc(ALICE),
        U128(5 * MIN_STREAM_AMOUNT),
        json!({ "send_to": BOB }).to_string(),
    );
    assert!(
        matches!(res, PromiseOrValue::Value(U128(0))),
        "never hands the token a promise to read as the unused amount"
    );
    assert_eq!(get_created_receipts().len(), 2);
}

#[test]
#[should_panic(expected = "Sends must be at least 1 USDC")]
fn send_has_a_minimum() {
    let mut c = new_contract();
    set_ctx(USDC, START);
    c.ft_on_transfer(
        acc(ALICE),
        U128(MIN_STREAM_AMOUNT - 1),
        json!({ "send_to": BOB }).to_string(),
    );
}

// ---------- prune and pagination ----------

#[test]
fn prune_deletes_only_settled_streams() {
    let mut c = new_contract();
    fund(
        &mut c,
        &[(ALICE, DEPOSIT, START, STOP), (BOB, DEPOSIT, START, STOP)],
    );
    // Stream 1 is fully paid out, as if its closing callback had not run yet.
    set_ctx(ALICE, STOP);
    c.withdraw(1, None, None);
    set_ctx("anyone.testnet", STOP);
    assert_eq!(c.prune(vec![1, 2, 99]), 1);
    assert!(c.get_stream(1).is_none());
    assert!(c.get_stream(2).is_some(), "Bob has not been paid");
}

#[test]
fn streams_of_is_paginated() {
    let mut c = new_contract();
    let streams: Vec<_> = (0..25)
        .map(|_| (ALICE, MIN_STREAM_AMOUNT, START, STOP))
        .collect();
    fund(&mut c, &streams);
    fund(&mut c, &streams);
    assert_eq!(c.stream_count_of(acc(ALICE)), 50);
    assert_eq!(c.streams_of(acc(ALICE), None, Some(20)).len(), 20);
    assert_eq!(c.streams_of(acc(ALICE), Some(40), Some(20)).len(), 10);
    assert_eq!(c.streams_of(acc(ALICE), None, Some(1_000)).len(), 50);
    assert_eq!(c.streams_of(acc(ALICE), Some(45), None)[0].id, 46);
}

// ---------- owner ----------

#[test]
fn owner_sets_fees_within_the_cap() {
    let mut c = new_contract();
    set_ctx(OWNER, START);
    c.set_fees(U128(MAX_FEE), U128(0));
    assert_eq!(c.config().stream_fee.0, MAX_FEE);
}

#[test]
#[should_panic(expected = "Fee above the 1 USDC cap")]
fn fees_are_capped() {
    let mut c = new_contract();
    set_ctx(OWNER, START);
    c.set_fees(U128(MAX_FEE + 1), U128(0));
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_the_owner_sets_fees() {
    let mut c = new_contract();
    set_ctx(EMPLOYER, START);
    c.set_fees(U128(0), U128(0));
}

#[test]
fn ownership_moves_in_two_steps() {
    let mut c = new_contract();
    set_ctx(OWNER, START);
    c.propose_owner(acc(BOB));
    assert_eq!(c.config().owner, acc(OWNER));
    set_ctx(BOB, START);
    c.accept_owner();
    assert_eq!(c.config().owner, acc(BOB));
    assert!(c.config().proposed_owner.is_none());
}

#[test]
#[should_panic(expected = "Not the proposed owner")]
fn ownership_cannot_be_taken() {
    let mut c = new_contract();
    set_ctx(BOB, START);
    c.accept_owner();
}

#[test]
fn owner_withdraws_fees_and_a_failure_puts_them_back() {
    let mut c = setup();
    set_ctx(OWNER, START);
    c.withdraw_fees(U128(FEE), acc(OWNER));
    assert_eq!(c.config().fees_collected.0, 0);
    set_callback(START, RICH, PromiseResult::Failed);
    c.on_paid(
        acc(OWNER),
        acc(OWNER),
        U128(FEE),
        U128(0),
        Source::Fees,
        Err(PromiseError::Failed),
    );
    assert_eq!(c.config().fees_collected.0, FEE);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_the_owner_upgrades() {
    let mut c = new_contract();
    set_ctx(EMPLOYER, START);
    c.upgrade();
}

// ---------- migration ----------

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct V1State {
    token: AccountId,
    next_id: u64,
    streams: LookupMap<u64, Stream>,
    by_account: LookupMap<AccountId, Vec<u64>>,
    owed: LookupMap<AccountId, u128>,
}

#[test]
fn migrates_the_1_0_0_layout_and_keeps_its_data() {
    set_ctx(CONTRACT, START);
    let mut streams = LookupMap::new(StorageKey::Streams);
    streams.insert(
        7,
        Stream {
            employer: acc(EMPLOYER),
            worker: acc(ALICE),
            deposit: DEPOSIT,
            withdrawn: 3,
            start: START - 100,
            stop: STOP,
        },
    );
    streams.flush();
    let mut by_account = LookupMap::new(StorageKey::ByAccount);
    by_account.insert(acc(ALICE), vec![7]);
    by_account.flush();
    let mut owed = LookupMap::new(StorageKey::Owed);
    owed.insert(acc(BOB), 42u128);
    owed.flush();
    let old = V1State {
        token: acc(USDC),
        next_id: 8,
        streams,
        by_account,
        owed,
    };
    env::storage_write(b"STATE", &near_sdk::borsh::to_vec(&old).unwrap());

    let c = Payday::migrate(Some(acc(OWNER)));
    assert_eq!(c.config().owner, acc(OWNER));
    assert_eq!(c.config().token, acc(USDC));
    assert_eq!(c.config().stream_fee.0, DEFAULT_STREAM_FEE);
    assert_eq!(stream(&c, 7).withdrawn.0, 3);
    assert_eq!(c.streams_of(acc(ALICE), None, None).len(), 1);
    assert_eq!(c.owed_of(acc(BOB)).0, 42);
}

#[test]
fn migrating_the_current_layout_changes_nothing() {
    let mut c = setup();
    set_ctx(OWNER, START);
    c.set_fees(U128(5), U128(6));
    env::state_write(&c);
    drop(c); // collections write their cached entries when dropped, as at the end of a call
    set_ctx(CONTRACT, START);
    let again = Payday::migrate(None);
    assert_eq!(again.config().stream_fee.0, 5);
    assert_eq!(again.config().registration_fee.0, 6);
    assert_eq!(stream(&again, 1).deposit.0, DEPOSIT);
}

// ---------- conservation ----------

/// After a cancel at any second, the employer refund plus everything the worker can
/// ever receive (paid, left in the stream, or owed) equals the original deposit.
#[test]
fn cancel_conserves_funds_at_every_second() {
    for t in (START..STOP).step_by(37) {
        let mut c = setup();
        set_ctx(ALICE, t);
        let early = stream(&c, 1).withdrawable.0;
        if early > 0 {
            c.withdraw(1, None, None);
        }
        set_ctx(EMPLOYER, t);
        c.cancel(1);
        let refund: u128 = events("stream_canceled")[0]["employer_refund"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let left = c.get_stream(1).map_or(0, |s| s.withdrawable.0) + c.owed_of(acc(ALICE)).0;
        assert_eq!(refund + early + left, DEPOSIT, "t = {t}");
    }
}
