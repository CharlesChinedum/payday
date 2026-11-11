import Link from "next/link";

const steps = [
  ["Employer funds payroll", "Upload a CSV of workers and send the total in USDC. One transaction creates every salary stream."],
  ["Salary accrues every second", "Each worker's balance grows in real time between the start and end dates."],
  ["Workers withdraw, gas-free", "Workers sign; Payday's relayer pays the NEAR gas. Workers never buy NEAR."],
  ["Cash out to any chain", "USDC on Base, Solana, Arbitrum or Ethereum, or USDT on Tron, through NEAR Intents."],
];

export default function Home() {
  return (
    <div className="space-y-10">
      <section className="max-w-2xl space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Payroll that pays every second, anywhere.
        </h1>
        <p className="text-lg text-muted">
          Pay a remote team in USDC. Salaries stream continuously, workers withdraw whenever they want without
          holding NEAR, and they cash out to the chain they already use.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link href="/employer" className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink">
            I pay people
          </Link>
          <Link href="/worker" className="rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium">
            I get paid
          </Link>
        </div>
      </section>

      <ol className="grid gap-4 sm:grid-cols-2">
        {steps.map(([title, body], i) => (
          <li key={title} className="rounded-xl border border-border bg-surface p-5">
            <div className="num mb-2 text-xs text-muted">0{i + 1}</div>
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-muted">{body}</p>
          </li>
        ))}
      </ol>

      <section className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
        <h2 className="mb-2 font-semibold text-text">Try it in two tabs</h2>
        Open <Link className="underline" href="/worker">Worker</Link> and copy your account. Open{" "}
        <Link className="underline" href="/employer">Employer</Link>, get test USDC, paste the worker account
        into the payroll CSV and fund it. Go back to Worker and watch the salary tick up, then withdraw. Both
        accounts live in this browser; no wallet or NEAR needed.
      </section>
    </div>
  );
}
