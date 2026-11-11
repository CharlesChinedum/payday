import "server-only";
import { ONE_USDC } from "../config";
import type { DelegateSummary, SponsoredCall } from "../policy";
import { accessKeyNonce, blockHeight, getStream, owedOf, paydayConfig, usdcBalanceOf } from "./chain";
import { HttpError } from "./http";

/** The longest a delegate may stay valid, in blocks (about ten minutes). */
const MAX_DELEGATE_BLOCKS = 600n;

const refuse = (reason: string): never => {
  throw new HttpError(409, reason);
};

/**
 * Checks against chain state that a signed, policy-approved delegate will execute and do
 * what it says, so the relayer never pays for a replay, an expired or far-future
 * delegate, or a call the contract would reject.
 */
export async function preflight(d: DelegateSummary, call: SponsoredCall): Promise<void> {
  if (!d.publicKey) return refuse("Only ed25519 keys are sponsored");
  const [keyNonce, height] = await Promise.all([accessKeyNonce(d.senderId, d.publicKey), blockHeight()]);
  if (keyNonce === null) return refuse("This account is not set up yet");
  if (d.nonce <= keyNonce) return refuse("This request was already used; sign it again");
  if (d.maxBlockHeight <= height) return refuse("This request has expired; sign it again");
  if (d.maxBlockHeight > height + MAX_DELEGATE_BLOCKS) return refuse("This request is valid for too long");

  await CHECKS[call.kind](d.senderId, call as never);
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
    if (call.receiver && call.receiver !== sender && amount < ONE_USDC) {
      return refuse("Payouts to another account must be at least 1 USDC");
    }
  },

  async claim_owed(sender) {
    if ((await owedOf(sender)) === 0n) return refuse("Nothing to claim");
  },

  async cancel(sender, call) {
    const stream = await getStream(call.streamId);
    if (!stream) return refuse("Stream not found");
    if (sender !== stream.employer && sender !== stream.worker) return refuse("Only the employer or worker can cancel");
  },

  async fund(sender, call) {
    const [balance, { streamFee, paused }] = await Promise.all([usdcBalanceOf(sender), paydayConfig()]);
    if (paused) return refuse("Funding is paused");
    const expected = call.streams.reduce((sum, s) => sum + s.amount + streamFee, 0n);
    if (call.amount !== expected) return refuse("Amount must equal the stream amounts plus the stream fees");
    if (balance < call.amount) return refuse("Not enough USDC");
  },

  async send(sender, call) {
    if ((await usdcBalanceOf(sender)) < call.amount) return refuse("Not enough USDC");
  },
};
