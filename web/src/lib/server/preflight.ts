import "server-only";
import { ONE_USDC } from "../config";
import type { DelegateSummary, SponsoredCall, StreamRequest } from "../policy";
import { accessKeyNonce, blockHeight, getStream, isRegistered, owedOf, paydayConfig, usdcBalanceOf } from "./chain";
import { HttpError } from "./http";

/** The longest a delegate may stay valid, in blocks (about ten minutes). */
const MAX_DELEGATE_BLOCKS = 600n;
/**
 * The shortest: a delegate that expires before its receipt runs fails on-chain after the
 * relayer has paid, without using up its nonce, so it could be replayed at no cost.
 */
const MIN_DELEGATE_BLOCKS = 30n;
/** NEAR rejects a nonce at or above block height × 10^6; such a delegate would fail on-chain. */
const NONCE_RANGE = 1_000_000n;
/** The contract's stream bounds, checked here so a funding that would be refunded is never paid for. */
const MAX_START_OFFSET_SECS = 365 * 24 * 3600;
const MAX_DURATION_SECS = 5 * 365 * 24 * 3600;
/** Chain time can run a little behind this server's clock. */
const CLOCK_SLACK_SECS = 60;

const refuse = (reason: string): never => {
  throw new HttpError(409, reason);
};

const nowSecs = () => Math.floor(Date.now() / 1000);

/**
 * Checks against chain state that a signed, policy-approved delegate will execute and do
 * what it says, so the relayer never pays for a replay, an expired or far-future
 * delegate, a call the contract would reject, or a payout too small to pay its own fees.
 */
export async function preflight(d: DelegateSummary, call: SponsoredCall): Promise<void> {
  if (!d.publicKey) return refuse("Only ed25519 keys are sponsored");
  const [keyNonce, height] = await Promise.all([accessKeyNonce(d.senderId, d.publicKey), blockHeight()]);
  if (keyNonce === null) return refuse("This account is not set up yet");
  if (d.nonce <= keyNonce) return refuse("This request was already used; sign it again");
  if (d.nonce >= height * NONCE_RANGE) return refuse("This request's nonce is too large");
  if (d.maxBlockHeight < height + MIN_DELEGATE_BLOCKS) return refuse("This request expires too soon; sign it again");
  if (d.maxBlockHeight > height + MAX_DELEGATE_BLOCKS) return refuse("This request is valid for too long");

  await CHECKS[call.kind](d.senderId, call as never);
}

/** The fees a payout to `receiver` will carry: the payout fee, plus registration if needed. */
async function payoutFees(receiver: string): Promise<bigint> {
  const [{ payoutFee, registrationFee }, registered] = await Promise.all([paydayConfig(), isRegistered(receiver)]);
  return payoutFee + (registered ? 0n : registrationFee);
}

function checkStream(sender: string, s: StreamRequest, now: number) {
  if (s.worker === sender) return refuse("A worker cannot be the employer");
  if (s.amount < ONE_USDC) return refuse("Each stream must be at least 1 USDC");
  if (s.stop <= s.start) return refuse("A stream must stop after it starts");
  if (s.stop <= now + CLOCK_SLACK_SECS) return refuse("A stream must stop in the future");
  if (Math.abs(s.start - now) > MAX_START_OFFSET_SECS - CLOCK_SLACK_SECS) return refuse("A stream must start within a year");
  if (s.stop - s.start > MAX_DURATION_SECS) return refuse("A stream can last at most five years");
}

type Check<K extends SponsoredCall["kind"]> = (sender: string, call: Extract<SponsoredCall, { kind: K }>) => Promise<void>;

const CHECKS: { [K in SponsoredCall["kind"]]: Check<K> } = {
  async withdraw(sender, call) {
    const stream = await getStream(call.streamId);
    if (!stream) return refuse("Stream not found");
    if (stream.worker !== sender) return refuse("Only the worker can withdraw");
    const available = BigInt(stream.withdrawable);
    const amount = call.amount ?? available;
    if (amount === 0n) return refuse("Nothing to withdraw yet");
    if (amount > available) return refuse("Amount exceeds what has vested");
    const left = BigInt(stream.deposit) - BigInt(stream.withdrawn);
    if (amount < ONE_USDC && amount !== left) return refuse("Withdraw at least 1 USDC, or everything left in the stream");
    if (amount <= (await payoutFees(call.receiver ?? sender))) return refuse("That amount does not cover the fees");
  },

  async claim_owed(sender, call) {
    const owed = await owedOf(sender);
    if (owed === 0n) return refuse("Nothing to claim");
    const receiver = call.receiver ?? sender;
    if (receiver !== sender && owed < ONE_USDC) return refuse("Payouts to another account must be at least 1 USDC");
    if (owed <= (await payoutFees(receiver))) return refuse("What you are owed does not cover the fees");
  },

  async cancel(sender, call) {
    const stream = await getStream(call.streamId);
    if (!stream) return refuse("Stream not found");
    if (sender !== stream.employer && sender !== stream.worker) return refuse("Only the employer or worker can cancel");
    // Chain time can pass `stop` before the call runs; the contract would then reject it.
    if (nowSecs() >= stream.stop - CLOCK_SLACK_SECS) return refuse("This stream has ended or ends within a minute");
  },

  async fund(sender, call) {
    const [balance, { streamFee, paused }] = await Promise.all([usdcBalanceOf(sender), paydayConfig()]);
    if (paused) return refuse("Funding is paused");
    const now = nowSecs();
    for (const s of call.streams) checkStream(sender, s, now);
    const expected = call.streams.reduce((sum, s) => sum + s.amount + streamFee, 0n);
    if (call.amount !== expected) return refuse("Amount must equal the stream amounts plus the stream fees");
    if (balance < call.amount) return refuse("Not enough USDC");
  },

  async send(sender, call) {
    if (call.sendTo === sender) return refuse("Cannot send to yourself");
    const [balance, fees] = await Promise.all([usdcBalanceOf(sender), payoutFees(call.sendTo)]);
    if (balance < call.amount) return refuse("Not enough USDC");
    if (call.amount <= fees) return refuse("That amount does not cover the fees");
  },
};
