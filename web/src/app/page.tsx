import Link from "next/link";
import type { ReactNode } from "react";
import { FlowAnimation } from "@/components/animations";
import { ArrowRightIcon, ArrowUpRightIcon } from "@/components/icons";
import { HeroPayslip } from "@/components/landing/HeroPayslip";
import { LiveStream } from "@/components/landing/LiveStream";
import { PayCurve } from "@/components/landing/PayCurve";
import { CASH_OUT_ASSETS } from "@/lib/config";

/** Each side of a payroll, in the order they happen. */
const TRACKS = [
  {
    who: "If you pay people",
    href: "/employer",
    cta: "Run a payroll",
    steps: [
      ["List your team", "Add workers in the form or drop in a CSV: account, amount, start and end date."],
      ["Fund it in one transfer", "Send the total in USDC. One transaction opens every salary, from 1 to 25 at a time."],
      ["Change course any time", "Cancel a stream and the unearned rest comes straight back. Export a CSV for your accountant."],
    ],
  },
  {
    who: "If you get paid",
    href: "/worker",
    cta: "See my pay",
    steps: [
      ["Share your account", "Open My pay and send your employer the account it shows. No wallet to install."],
      ["Watch it grow", "Your balance rises every second from the start date, in USDC and your local currency."],
      ["Take it out, gas-free", "Withdraw whenever you like, send it to any NEAR account or cash out to another chain."],
    ],
  },
] as const;

/** The three questions a business asks before trusting a payroll tool. */
const FACTS = [
  {
    q: "Where is the money?",
    a: "In the Payday contract on NEAR, not with us. It releases each salary by the second and nothing else: no one can take it out early, and cancelling returns only what was not yet earned.",
  },
  {
    q: "What does it cost?",
    a: "0.01 USDC per stream and 0.01 USDC per payout, plus a one-time 0.01 USDC to set up an account that has never held USDC. Nobody pays gas: Payday covers it.",
  },
  {
    q: "What can I check?",
    a: "Everything. Every stream, payout and fee is a public event on NEAR, and a worker's payslip is read live from the contract, so whoever receives it can verify it.",
  },
] as const;

const TESTNET_EXPLORER = "https://testnet.nearblocks.io";

/** Transactions made from this app on NEAR testnet on 11 Nov 2026, with what the relayer paid. */
const RECEIPTS = [
  { action: "Employer funds a salary from a CSV", hash: "HSxjnGc737EY7na2ro79iFRFpBMJ6qhmjaGzQuzAxiKs", relayerNear: "0.00094" },
  { action: "Worker withdraws earned salary", hash: "4mwKhaHbkNEA8tGt35b5K42D9cwJEaLbujZ6pym5HZC6", relayerNear: "0.00067" },
  { action: "Employer cancels and is refunded", hash: "9qYbKwtVzbtXXuYCMPsZYGbWYsCshNrnCtUdqarm1TgW", relayerNear: "0.00067" },
];

function Section({ id, children, className = "" }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 ${className}`}>
      {children}
    </section>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="num text-xs uppercase tracking-[0.2em] text-muted">{children}</p>;
}

function Hero() {
  return (
    <div className="dot-grid border-b border-border">
      <Section className="grid items-center gap-12 !py-14 sm:!py-20 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="animate-rise">
          <Eyebrow>Payroll on NEAR · USDC</Eyebrow>
          <h1 className="display mt-5 text-6xl sm:text-7xl lg:text-[5.75rem]">
            Payday is
            <br />
            every{" "}
            <em className="relative isolate inline-block">
              second.
              <span className="absolute inset-x-0 bottom-[0.12em] -z-10 h-[0.28em] bg-lime" aria-hidden="true" />
            </em>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted">
            Pay a remote team in USDC that streams by the second. Workers withdraw whenever they want, never touch a
            gas token, and cash out to the chain they already use.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/employer"
              className="group inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-medium text-accent-ink transition duration-150 hover:brightness-110 active:scale-[0.97]"
            >
              Run a payroll
              <ArrowRightIcon className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/worker"
              className="inline-flex items-center rounded-xl border border-border bg-surface px-5 py-3 text-sm font-medium transition duration-150 hover:bg-surface-2 active:scale-[0.97]"
            >
              See my pay
            </Link>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
            <li>No wallet to install</li>
            <li>No gas for workers</li>
            <li>Every unit accounted for on-chain</li>
          </ul>
        </div>
        <div className="animate-rise [animation-delay:120ms]">
          <HeroPayslip />
        </div>
      </Section>
    </div>
  );
}

function Why() {
  return (
    <Section className="reveal grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
      <div>
        <Eyebrow>Why</Eyebrow>
        <h2 className="display mt-4 text-4xl sm:text-5xl">A month is a long time to wait for money you already earned.</h2>
        <p className="mt-5 text-muted">
          With month-end payroll, a worker lends their employer every day of work until the 30th. For a team spread
          across borders, add days of bank transfers and a slice lost to fees and exchange rates.
        </p>
        <p className="mt-3 text-muted">
          Payday pays for each second as it is worked. Drag across the chart to see what a worker can actually spend on
          any given day.
        </p>
      </div>
      <PayCurve />
    </Section>
  );
}

function How() {
  return (
    <div className="border-y border-border bg-surface">
      <Section className="reveal">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="display mt-4 max-w-2xl text-4xl sm:text-5xl">One transfer in. A salary a second out.</h2>

        <div className="mx-auto mt-10 max-w-3xl">
          <FlowAnimation className="aspect-[3/1] w-full" />
          <div className="num mt-1 grid grid-cols-3 text-[11px] uppercase tracking-wider text-muted">
            <span>Employer</span>
            <span className="text-center">Payday contract</span>
            <span className="text-right">Workers</span>
          </div>
        </div>

        <div className="mt-12 grid gap-4 lg:grid-cols-2">
          {TRACKS.map((track) => (
            <div key={track.who} className="flex flex-col rounded-2xl border border-border bg-bg p-6 sm:p-8">
              <h3 className="num text-xs uppercase tracking-[0.2em] text-muted">{track.who}</h3>
              <ol className="mt-5 flex-1 space-y-5">
                {track.steps.map(([title, body], i) => (
                  <li key={title} className="group grid grid-cols-[2rem_1fr] gap-x-3">
                    <span
                      aria-hidden="true"
                      className="num grid h-8 w-8 place-items-center rounded-full border border-border text-xs text-muted transition-colors duration-200 group-hover:border-accent group-hover:bg-accent group-hover:text-accent-ink"
                    >
                      {i + 1}
                    </span>
                    <div>
                      <p className="font-semibold tracking-tight">{title}</p>
                      <p className="mt-1 text-sm text-muted">{body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <Link
                href={track.href}
                className="group mt-7 inline-flex items-center gap-1.5 self-start text-sm font-medium text-accent hover:underline"
              >
                {track.cta}
                <ArrowRightIcon className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
            </div>
          ))}
        </div>

        <dl className="mt-4 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-3">
          {FACTS.map((f) => (
            <div key={f.q} className="bg-surface p-6">
              <dt className="font-semibold tracking-tight">{f.q}</dt>
              <dd className="mt-2 text-sm text-muted">{f.a}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}

function Proof() {
  return (
    <Section className="reveal grid gap-10 lg:grid-cols-2 lg:gap-16">
      <div>
        <Eyebrow>Proof</Eyebrow>
        <h2 className="display mt-4 text-4xl sm:text-5xl">Don&apos;t take our word for it. Watch one.</h2>
        <p className="mt-5 text-muted">
          The card is a real salary stream, read from the Payday contract on NEAR testnet as you load this page. The
          number is what its worker has earned up to this second.
        </p>

        <h3 className="mt-8 text-sm font-semibold">What gas-free actually costs</h3>
        <p className="mt-1 text-sm text-muted">
          Transactions made from this app. The user paid nothing; this is what Payday&apos;s relayer paid.
        </p>
        <ul className="mt-4 divide-y divide-border border-y border-border text-sm">
          {RECEIPTS.map((r) => (
            <li key={r.hash} className="flex items-center gap-3 py-3">
              <span className="flex-1">{r.action}</span>
              <span className="num text-muted">{r.relayerNear} NEAR</span>
              <a
                href={`${TESTNET_EXPLORER}/txns/${r.hash}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`View transaction ${r.hash}`}
                className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                <ArrowUpRightIcon />
              </a>
            </li>
          ))}
        </ul>
      </div>
      <div className="lg:pt-10">
        <LiveStream />
      </div>
    </Section>
  );
}

function CashOut() {
  return (
    <div className="border-y border-border bg-surface">
      <Section className="reveal">
        <Eyebrow>Cash out</Eyebrow>
        <h2 className="display mt-4 max-w-2xl text-4xl sm:text-5xl">Earned on NEAR. Spent wherever you live.</h2>
        <p className="mt-5 max-w-2xl text-muted">
          A withdrawal can go straight from the salary stream to another chain through NEAR Intents, in one gas-free
          step. A test quote on 11 Nov 2026 turned 50 USDC on NEAR into 49.988 USDC on Base, estimated at 22 seconds.
        </p>
        <ul className="mt-8 flex flex-wrap gap-3">
          {CASH_OUT_ASSETS.map((asset) => (
            <li
              key={asset.id}
              className="rounded-full border border-border bg-bg px-4 py-2 text-sm transition duration-200 hover:-translate-y-0.5 hover:border-accent hover:text-accent"
            >
              {asset.label}
            </li>
          ))}
        </ul>
        <p className="mt-6 text-xs text-muted">
          NEAR Intents has no testnet, so this build shows live mainnet quotes; the swap itself goes live with the
          mainnet deployment.
        </p>
      </Section>
    </div>
  );
}

const DAO_STEPS = [
  ["Draft", "List contributors or import a CSV. Payday writes one proposal that opens every salary."],
  ["Vote", "Your council votes in the DAO tools it already uses. Payday never holds a key to the treasury."],
  ["Stream", "The vote that passes it funds the streams. Contributors are paid by the second from then on."],
] as const;

function Daos() {
  return (
    <Section className="reveal grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
      <div>
        <Eyebrow>For DAOs</Eyebrow>
        <h2 className="display mt-4 text-4xl sm:text-5xl">Your treasury votes once. Contributors get paid every second.</h2>
        <p className="mt-5 text-muted">
          A Sputnik DAO can run its payroll through Payday: the DAO is the employer, and every salary, payout and cancel
          is on-chain for members to check.
        </p>
        <Link href="/dao" className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
          Set up DAO payroll <ArrowRightIcon />
        </Link>
      </div>
      <ol className="grid gap-4 sm:grid-cols-3">
        {DAO_STEPS.map(([title, body], i) => (
          <li key={title} className="rounded-2xl border border-border bg-surface p-5">
            <span className="num text-xs text-muted">0{i + 1}</span>
            <h3 className="mt-2 font-medium">{title}</h3>
            <p className="mt-1 text-sm text-muted">{body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function ClosingCall() {
  return (
    <Section className="reveal">
      <div className="rounded-3xl bg-hero px-6 py-14 text-center text-hero-ink sm:px-12 sm:py-20">
        <h2 className="display mx-auto max-w-2xl text-5xl sm:text-6xl">
          Stop paying people <em className="text-lime">late.</em>
        </h2>
        <p className="mx-auto mt-5 max-w-md text-hero-ink/70">
          Try both sides in two browser tabs. It takes about a minute and needs no wallet.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/employer"
            className="rounded-xl bg-lime px-5 py-3 text-sm font-medium text-lime-ink transition duration-150 hover:brightness-105 active:scale-[0.97]"
          >
            Run a payroll
          </Link>
          <Link
            href="/worker"
            className="rounded-xl border border-hero-ink/25 px-5 py-3 text-sm font-medium transition duration-150 hover:bg-hero-ink/10 active:scale-[0.97]"
          >
            See my pay
          </Link>
        </div>
      </div>
    </Section>
  );
}

export default function Home() {
  return (
    <>
      <Hero />
      <Why />
      <How />
      <Proof />
      <CashOut />
      <Daos />
      <ClosingCall />
    </>
  );
}
