#![allow(unused_must_use)] // unit tests never execute returned promises
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const USDC: &str = "usdc.testnet";
const CONTRACT: &str = "payday.testnet";
const EMPLOYER: &str = "acme.testnet";
const ALICE: &str = "alice.testnet";
const BOB: &str = "bob.testnet";

const START: u64 = 1_000;
const STOP: u64 = 2_000;
const DEPOSIT: u128 = 1_000 * MIN_STREAM_AMOUNT; // 1,000 USDC over 1,000 s

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn set_ctx(predecessor: &str, now_secs: u64) {
    let ctx = VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(now_secs * NANOS_PER_SEC)
        .build();
    testing_env!(ctx);
}

fn set_callback_ctx(now_secs: u64, result: PromiseResult) {
    let ctx = VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(CONTRACT))
        .block_timestamp(now_secs * NANOS_PER_SEC)
        .build();
    testing_env!(
        ctx,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn funding_msg(streams: &[(&str, u128, u64, u64)]) -> String {
    let list: Vec<_> = streams
        .iter()
        .map(|(w, a, s, e)| json!({"worker": w, "amount": a.to_string(), "start": s, "stop": e}))
        .collect();
    json!({ "streams": list }).to_string()
}

/// Contract with one stream (id 1): EMPLOYER -> ALICE, DEPOSIT over START..STOP.
fn setup() -> Payday {
    set_ctx(EMPLOYER, 0);
    let mut c = Payday::new(acc(USDC));
    fund(&mut c, &[(ALICE, DEPOSIT, START, STOP)]);
    c
}

fn fund(c: &mut Payday, streams: &[(&str, u128, u64, u64)]) {
    set_ctx(USDC, 0);
    let total: u128 = streams.iter().map(|s| s.1).sum();
    let res = c.ft_on_transfer(acc(EMPLOYER), U128(total), funding_msg(streams));
    assert!(matches!(res, PromiseOrValue::Value(U128(0))));
}

fn stream(c: &Payday, id: u64) -> StreamView {
    c.get_stream(id).expect("stream exists")
}

// ---------- funding ----------

#[test]
fn funding_creates_streams_and_indexes_both_parties() {
    set_ctx(EMPLOYER, 0);
    let mut c = Payday::new(acc(USDC));
    fund(
        &mut c,
        &[
            (ALICE, DEPOSIT, START, STOP),
            (BOB, 2 * DEPOSIT, START, STOP),
        ],
    );

    let s1 = stream(&c, 1);
    assert_eq!(s1.worker, acc(ALICE));
    assert_eq!(s1.employer, acc(EMPLOYER));
    assert_eq!(s1.deposit.0, DEPOSIT);
    assert_eq!(stream(&c, 2).deposit.0, 2 * DEPOSIT);

    assert_eq!(c.streams_of(acc(EMPLOYER)).len(), 2);
    assert_eq!(c.streams_of(acc(ALICE)).len(), 1);
    assert_eq!(c.streams_of(acc(BOB)).len(), 1);
    assert!(get_logs().iter().all(|l| l.starts_with("EVENT_JSON:")));
}

#[test]
#[should_panic(expected = "Only the configured USDC token is accepted")]
fn funding_rejects_other_tokens() {
    set_ctx(EMPLOYER, 0);
    let mut c = Payday::new(acc(USDC));
    set_ctx("fake-usdc.testnet", 0);
    c.ft_on_transfer(
        acc(EMPLOYER),
        U128(DEPOSIT),
        funding_msg(&[(ALICE, DEPOSIT, START, STOP)]),
    );
}

#[test]
#[should_panic(expected = "Stream amounts must add up to the amount sent")]
fn funding_rejects_mismatched_total() {
    set_ctx(EMPLOYER, 0);
    let mut c = Payday::new(acc(USDC));
    set_ctx(USDC, 0);
    c.ft_on_transfer(
        acc(EMPLOYER),
        U128(DEPOSIT + 1),
        funding_msg(&[(ALICE, DEPOSIT, START, STOP)]),
    );
}

#[test]
#[should_panic(expected = "Stream amount below minimum")]
fn funding_rejects_dust_streams() {
    set_ctx(EMPLOYER, 0);
    let mut c = Payday::new(acc(USDC));
    fund(&mut c, &[(ALICE, MIN_STREAM_AMOUNT - 1, START, STOP)]);
}

#[test]
#[should_panic(expected = "Worker cannot be the employer")]
fn funding_rejects_self_stream() {
    set_ctx(EMPLOYER, 0);
    let mut c = Payday::new(acc(USDC));
    fund(&mut c, &[(EMPLOYER, DEPOSIT, START, STOP)]);
}

#[test]
#[should_panic(expected = "Stop must be in the future")]
fn funding_rejects_already_ended_stream() {
    set_ctx(EMPLOYER, 0);
    let mut c = Payday::new(acc(USDC));
    set_ctx(USDC, STOP);
    c.ft_on_transfer(
        acc(EMPLOYER),
        U128(DEPOSIT),
        funding_msg(&[(ALICE, DEPOSIT, START, STOP)]),
    );
}

#[test]
#[should_panic(expected = "Invalid funding msg")]
fn funding_rejects_bad_msg() {
    set_ctx(EMPLOYER, 0);
    let mut c = Payday::new(acc(USDC));
    set_ctx(USDC, 0);
    c.ft_on_transfer(acc(EMPLOYER), U128(DEPOSIT), "not json".into());
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
    assert_eq!(s.vested_at(START), 0);
    assert_eq!(s.vested_at(START + 250), DEPOSIT / 4);
    assert_eq!(s.vested_at(START + 500), DEPOSIT / 2);
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
fn worker_withdraws_vested_amount() {
    let mut c = setup();
    set_ctx(ALICE, START + 250);
    c.withdraw(1, None, None);
    let s = stream(&c, 1);
    assert_eq!(s.withdrawn.0, DEPOSIT / 4);
    assert_eq!(s.withdrawable.0, 0);
}

#[test]
fn worker_withdraws_partial_amount_to_another_receiver() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, Some(U128(100)), Some(acc("deposit.1click.near")));
    assert_eq!(stream(&c, 1).withdrawn.0, 100);
    assert_eq!(stream(&c, 1).withdrawable.0, DEPOSIT / 2 - 100);
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
fn failed_withdraw_is_credited_back_to_stream() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    assert_eq!(stream(&c, 1).withdrawable.0, 0);

    set_callback_ctx(START + 500, PromiseResult::Failed);
    let ok = c.on_withdraw(
        1,
        acc(ALICE),
        acc(ALICE),
        U128(DEPOSIT / 2),
        Err(PromiseError::Failed),
    );
    assert!(!ok);
    assert_eq!(stream(&c, 1).withdrawn.0, 0);
    assert_eq!(stream(&c, 1).withdrawable.0, DEPOSIT / 2);
}

#[test]
fn successful_withdraw_callback_keeps_books() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_callback_ctx(START + 500, PromiseResult::Successful(vec![]));
    assert!(c.on_withdraw(1, acc(ALICE), acc(ALICE), U128(DEPOSIT / 2), Ok(())));
    assert_eq!(stream(&c, 1).withdrawn.0, DEPOSIT / 2);
}

// ---------- cancel ----------

#[test]
fn employer_cancel_refunds_unvested_and_worker_keeps_vested() {
    let mut c = setup();
    set_ctx(EMPLOYER, START + 250);
    let res = c.cancel(1);
    assert!(matches!(res, PromiseOrValue::Promise(_)));

    let s = stream(&c, 1);
    assert_eq!(s.deposit.0, DEPOSIT / 4);
    assert_eq!(s.stop, START + 250);

    // Worker can still withdraw the earned quarter, and nothing more accrues.
    set_ctx(ALICE, STOP + 100);
    assert_eq!(stream(&c, 1).withdrawable.0, DEPOSIT / 4);
    c.withdraw(1, None, None);
    assert_eq!(stream(&c, 1).withdrawable.0, 0);
}

#[test]
fn worker_can_cancel_too() {
    let mut c = setup();
    set_ctx(ALICE, START + 500);
    c.cancel(1);
    assert_eq!(stream(&c, 1).deposit.0, DEPOSIT / 2);
}

#[test]
fn cancel_before_start_deletes_stream_and_index() {
    let mut c = setup();
    set_ctx(EMPLOYER, START - 1);
    c.cancel(1);
    assert!(c.get_stream(1).is_none());
    assert!(c.streams_of(acc(ALICE)).is_empty());
    assert!(c.streams_of(acc(EMPLOYER)).is_empty());
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

#[test]
fn failed_refund_becomes_owed_and_is_claimable() {
    let mut c = setup();
    set_ctx(EMPLOYER, START - 1);
    c.cancel(1);

    set_callback_ctx(START, PromiseResult::Failed);
    assert!(!c.on_transfer_or_owe(acc(EMPLOYER), U128(DEPOSIT), Err(PromiseError::Failed)));
    assert_eq!(c.owed_of(acc(EMPLOYER)).0, DEPOSIT);

    set_ctx(EMPLOYER, START);
    c.claim_owed();
    assert_eq!(c.owed_of(acc(EMPLOYER)).0, 0);
}

#[test]
fn failed_withdraw_after_stream_deleted_becomes_owed() {
    let mut c = setup();
    // Alice withdraws everything vested, then the stream is cancelled while her
    // transfer is in flight: nothing remains for her, so the stream is deleted.
    set_ctx(ALICE, START + 500);
    c.withdraw(1, None, None);
    set_ctx(EMPLOYER, START + 500);
    c.cancel(1);
    assert!(c.get_stream(1).is_none());

    set_callback_ctx(START + 500, PromiseResult::Failed);
    c.on_withdraw(
        1,
        acc(ALICE),
        acc(ALICE),
        U128(DEPOSIT / 2),
        Err(PromiseError::Failed),
    );
    assert_eq!(c.owed_of(acc(ALICE)).0, DEPOSIT / 2);
}

#[test]
#[should_panic(expected = "Nothing owed")]
fn claim_owed_requires_balance() {
    let mut c = setup();
    set_ctx(BOB, START);
    c.claim_owed();
}

// ---------- conservation ----------

/// At every step, tokens held for a stream equal deposit - withdrawn, and the employer
/// refund plus everything the worker can ever receive equals the original deposit.
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
        let refund = stream(&c, 1).deposit.0 - stream(&c, 1).withdrawable.0 - early;
        c.cancel(1);
        let worker_left = c.get_stream(1).map_or(0, |s| s.withdrawable.0);
        assert_eq!(refund + early + worker_left, DEPOSIT, "t = {t}");
    }
}

#[test]
#[should_panic(expected = "Too many streams in one transfer")]
fn funding_rejects_oversized_batch() {
    set_ctx(EMPLOYER, 0);
    let mut c = Payday::new(acc(USDC));
    let workers: Vec<String> = (0..=MAX_BATCH).map(|i| format!("w{i}.testnet")).collect();
    let streams: Vec<_> = workers
        .iter()
        .map(|w| (w.as_str(), MIN_STREAM_AMOUNT, START, STOP))
        .collect();
    fund(&mut c, &streams);
}
