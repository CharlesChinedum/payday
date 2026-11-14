"use client";

import { useState, type PointerEvent } from "react";

const DAYS = 30;
const SALARY = 3_000;
const WIDTH = 600;
const HEIGHT = 260;
const PAD = { left: 10, right: 10, top: 18, bottom: 30 };
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom;
const TICK_DAYS = [0, 10, 20, 30];

const x = (day: number) => PAD.left + (day / DAYS) * PLOT_WIDTH;
const y = (amount: number) => HEIGHT - PAD.bottom - (amount / SALARY) * PLOT_HEIGHT;
const usd = (amount: number) => `$${amount.toLocaleString("en-US")}`;

function dayFromPointer(e: PointerEvent<SVGSVGElement>): number {
  const box = e.currentTarget.getBoundingClientRect();
  const svgX = ((e.clientX - box.left) / box.width) * WIDTH;
  const day = Math.round(((svgX - PAD.left) / PLOT_WIDTH) * DAYS);
  return Math.min(DAYS, Math.max(0, day));
}

/** Compares what a worker can actually spend by a given day under each way of paying. */
export function PayCurve() {
  const [day, setDay] = useState(12);
  const earned = Math.round((SALARY * day) / DAYS);
  const monthEndPaid = day === DAYS ? SALARY : 0;
  const lockedUp = earned - monthEndPaid;

  return (
    <figure className="rounded-2xl border border-border bg-surface p-4 sm:p-6">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full cursor-crosshair touch-none select-none"
        role="img"
        aria-label={`By day ${day}, month-end payroll has paid ${usd(monthEndPaid)} and Payday has paid ${usd(earned)}`}
        onPointerMove={(e) => setDay(dayFromPointer(e))}
        onPointerDown={(e) => setDay(dayFromPointer(e))}
      >
        <polygon
          points={`${x(0)},${y(0)} ${x(day)},${y(0)} ${x(day)},${y(earned)}`}
          className="fill-text/10 transition-all duration-150"
        />
        <line x1={x(0)} y1={y(0)} x2={x(DAYS)} y2={y(0)} className="stroke-border" strokeWidth="1.5" />
        {TICK_DAYS.map((d) => (
          <text key={d} x={x(d)} y={HEIGHT - 8} textAnchor={d === 0 ? "start" : d === DAYS ? "end" : "middle"} className="num fill-muted text-[11px]">
            day {d}
          </text>
        ))}
        <polyline
          points={`${x(0)},${y(0)} ${x(DAYS)},${y(0)} ${x(DAYS)},${y(SALARY)}`}
          fill="none"
          className="stroke-muted"
          strokeWidth="2.5"
          strokeDasharray="6 6"
          strokeLinejoin="round"
        />
        <line x1={x(0)} y1={y(0)} x2={x(DAYS)} y2={y(SALARY)} className="stroke-lime" strokeWidth="3.5" strokeLinecap="round" />
        <line x1={x(day)} y1={y(0)} x2={x(day)} y2={PAD.top} className="stroke-text/25 transition-all duration-150" strokeWidth="1" />
        <circle cx={x(day)} cy={y(monthEndPaid)} r="6" className="fill-surface stroke-muted transition-all duration-150" strokeWidth="2.5" />
        <circle cx={x(day)} cy={y(earned)} r="7" className="fill-lime stroke-surface transition-all duration-150" strokeWidth="3" />
      </svg>

      <label className="mt-2 block">
        <span className="sr-only">Day of the month</span>
        <input
          type="range"
          min={0}
          max={DAYS}
          value={day}
          onChange={(e) => setDay(Number(e.target.value))}
          className="w-full accent-[var(--lime)]"
        />
      </label>

      <figcaption className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <div className="flex items-center gap-2 text-muted">
            <span className="h-0.5 w-5 border-t-2 border-dashed border-muted" /> Month-end payroll
          </div>
          <div className="num mt-1 text-xl font-medium">{usd(monthEndPaid)}</div>
          <div className="text-xs text-muted">paid by day {day}</div>
        </div>
        <div>
          <div className="flex items-center gap-2 text-muted">
            <span className="h-1 w-5 rounded-full bg-lime" /> Payday
          </div>
          <div className="num mt-1 text-xl font-medium">{usd(earned)}</div>
          <div className="text-xs text-muted">paid by day {day}</div>
        </div>
        <div>
          <div className="flex items-center gap-2 text-muted">
            <span className="h-3 w-5 rounded-sm bg-text/15" /> Earned but out of reach
          </div>
          <div className="num mt-1 text-xl font-medium">{usd(lockedUp)}</div>
          <div className="text-xs text-muted">with month-end payroll, on a {usd(SALARY)} salary</div>
        </div>
      </figcaption>
    </figure>
  );
}
