import type { AnalyticsRow } from "../gsc/client";

/** Search Console data usually lags 2–3 days; default ranges end 3 days ago. */
export const DEFAULT_LAG_DAYS = 3;

const DAY_MS = 86_400_000;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseIso(date: string): Date {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD).`);
  return d;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

export function resolveRange(opts: { start_date?: string; end_date?: string; days?: number }): DateRange {
  const days = opts.days ?? 28;
  const end = opts.end_date
    ? parseIso(opts.end_date)
    : new Date(Date.now() - DEFAULT_LAG_DAYS * DAY_MS);
  const start = opts.start_date ? parseIso(opts.start_date) : new Date(end.getTime() - (days - 1) * DAY_MS);
  if (start > end) throw new Error("start_date must be before end_date.");
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

/** The period of equal length immediately before `range`. */
export function previousRange(range: DateRange): DateRange {
  const start = parseIso(range.startDate);
  const end = parseIso(range.endDate);
  const len = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  const prevEnd = new Date(start.getTime() - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - (len - 1) * DAY_MS);
  return { startDate: isoDate(prevStart), endDate: isoDate(prevEnd) };
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtPct = (ratio: number) => `${(ratio * 100).toFixed(2)}%`;
export const fmtPos = (n: number) => n.toFixed(1);

export function fmtDelta(current: number, previous: number, kind: "int" | "pct" | "pos" = "int"): string {
  const diff = current - previous;
  const sign = diff > 0 ? "+" : "";
  let abs: string;
  if (kind === "pct") abs = `${sign}${(diff * 100).toFixed(2)} pp`;
  else if (kind === "pos") abs = `${sign}${diff.toFixed(1)}`;
  else abs = `${sign}${fmtInt(diff)}`;
  if (kind !== "int" || previous === 0) return abs;
  return `${abs} (${sign}${((diff / previous) * 100).toFixed(1)}%)`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function table(headers: string[], rows: (string | number)[][]): string {
  if (!rows.length) return "_No rows._";
  const head = `| ${headers.map(escapeCell).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((c) => escapeCell(String(c))).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

export function rowMetrics(r: AnalyticsRow): string[] {
  return [fmtInt(r.clicks), fmtInt(r.impressions), fmtPct(r.ctr), fmtPos(r.position)];
}

export const METRIC_HEADERS = ["Clicks", "Impressions", "CTR", "Position"];

export interface Totals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export function totalsFromRows(rows: AnalyticsRow[]): Totals {
  // A query without dimensions returns a single aggregated row.
  const r = rows[0];
  return r
    ? { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
}
