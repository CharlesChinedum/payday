/**
 * Local-currency display. Amounts stay in USDC everywhere; this only adds an approximate
 * local value next to them, at a daily mid-market USD rate, with USDC counted as 1 USD.
 */

export interface Currency {
  code: string;
  name: string;
  /** ISO 3166 regions whose browsers default to this currency. */
  regions: readonly string[];
}

/** Where remote teams paid in dollars most often live, plus the big reference currencies. */
export const CURRENCIES: readonly Currency[] = [
  { code: "NGN", name: "Nigerian naira", regions: ["NG"] },
  { code: "KES", name: "Kenyan shilling", regions: ["KE"] },
  { code: "GHS", name: "Ghanaian cedi", regions: ["GH"] },
  { code: "ZAR", name: "South African rand", regions: ["ZA"] },
  { code: "EGP", name: "Egyptian pound", regions: ["EG"] },
  { code: "UGX", name: "Ugandan shilling", regions: ["UG"] },
  { code: "TZS", name: "Tanzanian shilling", regions: ["TZ"] },
  { code: "RWF", name: "Rwandan franc", regions: ["RW"] },
  { code: "MAD", name: "Moroccan dirham", regions: ["MA"] },
  { code: "XOF", name: "West African CFA franc", regions: ["SN", "CI", "BJ", "BF", "ML", "NE", "TG", "GW"] },
  { code: "INR", name: "Indian rupee", regions: ["IN"] },
  { code: "PKR", name: "Pakistani rupee", regions: ["PK"] },
  { code: "BDT", name: "Bangladeshi taka", regions: ["BD"] },
  { code: "PHP", name: "Philippine peso", regions: ["PH"] },
  { code: "IDR", name: "Indonesian rupiah", regions: ["ID"] },
  { code: "VND", name: "Vietnamese dong", regions: ["VN"] },
  { code: "TRY", name: "Turkish lira", regions: ["TR"] },
  { code: "UAH", name: "Ukrainian hryvnia", regions: ["UA"] },
  { code: "BRL", name: "Brazilian real", regions: ["BR"] },
  { code: "ARS", name: "Argentine peso", regions: ["AR"] },
  { code: "MXN", name: "Mexican peso", regions: ["MX"] },
  { code: "COP", name: "Colombian peso", regions: ["CO"] },
  { code: "EUR", name: "Euro", regions: ["DE", "FR", "ES", "IT", "NL", "PT", "IE", "BE", "AT", "FI", "GR"] },
  { code: "GBP", name: "British pound", regions: ["GB"] },
];

const CODES = new Set(CURRENCIES.map((c) => c.code));

export interface Rates {
  /** Unix seconds of the provider's last update. */
  updated: number;
  /** Units of each currency per 1 USD. */
  perUsd: Record<string, number>;
}

/**
 * Validates the provider's answer and keeps only the currencies Payday offers, so nothing
 * unexpected from upstream ever reaches a page.
 */
export function parseRates(body: unknown): Rates {
  const b = body as { result?: unknown; base_code?: unknown; time_last_update_unix?: unknown; rates?: unknown } | null;
  if (!b || b.result !== "success" || b.base_code !== "USD") throw new Error("unexpected rates response");
  if (!Number.isSafeInteger(b.time_last_update_unix)) throw new Error("rates have no update time");
  if (typeof b.rates !== "object" || b.rates === null) throw new Error("rates missing");
  const perUsd: Record<string, number> = {};
  for (const code of CODES) {
    const rate = (b.rates as Record<string, unknown>)[code];
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate < 1e7) perUsd[code] = rate;
  }
  if (Object.keys(perUsd).length < CODES.size / 2) throw new Error("too few rates");
  return { updated: b.time_last_update_unix as number, perUsd };
}

/** The currency to suggest for a browser's languages, e.g. "en-NG" → NGN; null if none fits. */
export function guessCurrency(languages: readonly string[]): string | null {
  for (const tag of languages) {
    const region = tag.split("-").find((part, i) => i > 0 && /^[A-Z]{2}$/.test(part));
    const match = region && CURRENCIES.find((c) => c.regions.includes(region));
    if (match) return match.code;
  }
  return null;
}

/** USDC base units (6 decimals) as a local amount. */
export function toLocal(units: bigint, rate: number): number {
  return (Number(units) / 1e6) * rate;
}

/** "₦1,349,823" for large amounts, "KSh 129.97" for small ones. */
export function formatLocal(amount: number, code: string, locale?: string): string {
  const digits = Math.abs(amount) >= 1000 ? 0 : 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(amount);
}
