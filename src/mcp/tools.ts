import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type AnalyticsFilter, type AnalyticsRow, GscApiError, type GscClient } from "../gsc/client";
import {
  fmtDelta,
  fmtInt,
  fmtPct,
  fmtPos,
  METRIC_HEADERS,
  previousRange,
  resolveRange,
  rowMetrics,
  table,
  totalsFromRows,
} from "./format";

export interface ToolContext {
  client: () => GscClient;
  user: () => string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// ---- shared schemas -------------------------------------------------------

const siteUrl = z
  .string()
  .describe(
    'Search Console property. Accepts "sc-domain:example.com", "https://www.example.com/" or a bare domain like "example.com". Use list_properties to see the exact values.',
  );
const startDate = z.string().optional().describe("Start date YYYY-MM-DD. Defaults to `days` before end_date.");
const endDate = z
  .string()
  .optional()
  .describe("End date YYYY-MM-DD. Defaults to 3 days ago (Search Console data lags 2–3 days).");
const days = z.number().int().min(1).max(486).optional().describe("Length of the range in days when start_date is omitted. Default 28.");
const dimensionEnum = z.enum(["query", "page", "country", "device", "date", "searchAppearance"]);
const searchType = z
  .enum(["web", "image", "video", "news", "discover", "googleNews"])
  .optional()
  .describe("Search type. Default web.");
const filterSchema = z.object({
  dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]),
  operator: z
    .enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"])
    .default("contains"),
  expression: z.string().describe("Value to match. Countries use ISO 3166-1 alpha-3 (e.g. ESP); devices are DESKTOP, MOBILE, TABLET."),
});
const filters = z.array(filterSchema).max(10).optional().describe("Filters combined with AND.");

// ---- helpers --------------------------------------------------------------

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

function errorMessage(err: unknown, serviceAccount: string): string {
  if (err instanceof GscApiError) {
    if (err.status === 403) {
      return (
        `Access denied by Google (403): ${err.message}\n` +
        `Make sure ${serviceAccount} is added as a user of the property in Search Console → Settings → Users and permissions.`
      );
    }
    if (err.status === 429) return `Google quota exceeded (429): ${err.message}. Try again later or reduce the request size.`;
    return `Search Console API error (${err.status}): ${err.message}`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

function mapFilters(input?: z.infer<typeof filterSchema>[]): AnalyticsFilter[] | undefined {
  return input?.map((f) => ({ dimension: f.dimension, operator: f.operator, expression: f.expression }));
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- registration ---------------------------------------------------------

export function registerTools(server: McpServer, ctx: ToolContext): void {
  /** Wraps every handler with error formatting and a structured usage log. */
  function register<S extends Record<string, z.ZodType>>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>, client: GscClient) => Promise<string>,
  ): void {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        // MCP SDK v2 expects a full schema object, not a raw shape.
        inputSchema: z.object(config.inputSchema),
        annotations: { title: config.title, ...READ_ONLY },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any): Promise<ToolResult> => {
        const started = Date.now();
        let client: GscClient | undefined;
        try {
          client = ctx.client();
          const out = await handler(args, client);
          console.log(JSON.stringify({ event: "tool_call", tool: name, user: ctx.user(), ok: true, ms: Date.now() - started }));
          return text(out);
        } catch (err) {
          console.log(
            JSON.stringify({
              event: "tool_call",
              tool: name,
              user: ctx.user(),
              ok: false,
              ms: Date.now() - started,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          return { ...text(errorMessage(err, client?.serviceAccountEmail ?? "the service account")), isError: true };
        }
      }) as never,
    );
  }

  // 1. list_properties
  register(
    "list_properties",
    {
      title: "List Search Console properties",
      description: "Lists the Search Console properties the configured service account can access, with its permission level.",
      inputSchema: {},
    },
    async (_args, client) => {
      const sites = await client.listSites(true);
      return (
        `Service account: ${client.serviceAccountEmail}\n\n` +
        table(
          ["Property", "Permission"],
          sites.map((s) => [s.siteUrl, s.permissionLevel]),
        )
      );
    },
  );

  // 2. get_search_analytics
  register(
    "get_search_analytics",
    {
      title: "Search analytics",
      description:
        "Clicks, impressions, CTR and average position from Search Console, grouped by the chosen dimensions. " +
        "Google returns the top rows by clicks; order_by only re-sorts the returned rows.",
      inputSchema: {
        site_url: siteUrl,
        start_date: startDate,
        end_date: endDate,
        days,
        dimensions: z.array(dimensionEnum).max(4).optional().describe('Group by these dimensions. Default ["query"].'),
        search_type: searchType,
        filters,
        row_limit: z.number().int().min(1).max(25000).optional().describe("Max rows. Default 100."),
        start_row: z.number().int().min(0).optional().describe("Offset for pagination. Default 0."),
        order_by: z.enum(["clicks", "impressions", "ctr", "position"]).optional(),
        data_state: z.enum(["final", "all"]).optional().describe('"all" includes fresh, not yet final data. Default final.'),
      },
    },
    async (args, client) => {
      const site = await client.resolveSite(args.site_url);
      const range = resolveRange(args);
      const dimensions = args.dimensions?.length ? args.dimensions : ["query"];
      const rows = await client.searchAnalytics(site, {
        ...range,
        dimensions,
        type: args.search_type,
        filters: mapFilters(args.filters),
        rowLimit: args.row_limit ?? 100,
        startRow: args.start_row,
        dataState: args.data_state,
      });
      if (args.order_by) {
        const key = args.order_by;
        rows.sort((a, b) => (key === "position" ? a.position - b.position : b[key] - a[key]));
      }
      const header = `Property: ${site} · ${range.startDate} → ${range.endDate} · type: ${args.search_type ?? "web"} · rows: ${rows.length}`;
      return (
        `${header}\n\n` +
        table(
          [...dimensions, ...METRIC_HEADERS],
          rows.map((r) => [...(r.keys ?? []), ...rowMetrics(r)]),
        )
      );
    },
  );

  // 3. get_performance_overview
  register(
    "get_performance_overview",
    {
      title: "Performance overview",
      description:
        "Totals for a period compared with the previous period of equal length, plus the daily trend.",
      inputSchema: { site_url: siteUrl, start_date: startDate, end_date: endDate, days, search_type: searchType },
    },
    async (args, client) => {
      const site = await client.resolveSite(args.site_url);
      const range = resolveRange(args);
      const prev = previousRange(range);
      const type = args.search_type;
      const [cur, before, daily] = await Promise.all([
        client.searchAnalytics(site, { ...range, type }),
        client.searchAnalytics(site, { ...prev, type }),
        client.searchAnalytics(site, { ...range, type, dimensions: ["date"], rowLimit: 500 }),
      ]);
      const c = totalsFromRows(cur);
      const p = totalsFromRows(before);
      daily.sort((a, b) => (a.keys?.[0] ?? "").localeCompare(b.keys?.[0] ?? ""));
      return [
        `Property: ${site} · ${range.startDate} → ${range.endDate} vs ${prev.startDate} → ${prev.endDate} · type: ${type ?? "web"}`,
        "",
        table(
          ["Metric", "Current", "Previous", "Change"],
          [
            ["Clicks", fmtInt(c.clicks), fmtInt(p.clicks), fmtDelta(c.clicks, p.clicks)],
            ["Impressions", fmtInt(c.impressions), fmtInt(p.impressions), fmtDelta(c.impressions, p.impressions)],
            ["CTR", fmtPct(c.ctr), fmtPct(p.ctr), fmtDelta(c.ctr, p.ctr, "pct")],
            ["Avg. position", fmtPos(c.position), fmtPos(p.position), fmtDelta(c.position, p.position, "pos")],
          ],
        ),
        "",
        "Daily trend:",
        table(["Date", ...METRIC_HEADERS], daily.map((r) => [r.keys?.[0] ?? "", ...rowMetrics(r)])),
      ].join("\n");
    },
  );

  // 4. compare_search_periods
  register(
    "compare_search_periods",
    {
      title: "Compare periods",
      description:
        "Compares two date ranges by query or page: totals, biggest click gains and losses, and new or lost items. " +
        "If period 2 is omitted, the previous period of equal length is used.",
      inputSchema: {
        site_url: siteUrl,
        period1_start: z.string().optional().describe("Recent period start YYYY-MM-DD. Defaults to last 28 days."),
        period1_end: z.string().optional().describe("Recent period end YYYY-MM-DD."),
        period2_start: z.string().optional().describe("Earlier period start YYYY-MM-DD."),
        period2_end: z.string().optional().describe("Earlier period end YYYY-MM-DD."),
        dimension: z.enum(["query", "page"]).optional().describe("Default query."),
        search_type: searchType,
        filters,
        limit: z.number().int().min(1).max(100).optional().describe("Rows per section. Default 20."),
      },
    },
    async (args, client) => {
      const site = await client.resolveSite(args.site_url);
      const p1 = resolveRange({ start_date: args.period1_start, end_date: args.period1_end });
      const p2 =
        args.period2_start && args.period2_end
          ? resolveRange({ start_date: args.period2_start, end_date: args.period2_end })
          : previousRange(p1);
      const dim = args.dimension ?? "query";
      const limit = args.limit ?? 20;
      const base = { type: args.search_type, filters: mapFilters(args.filters) };

      const [t1, t2, r1, r2] = await Promise.all([
        client.searchAnalytics(site, { ...p1, ...base }),
        client.searchAnalytics(site, { ...p2, ...base }),
        client.searchAnalytics(site, { ...p1, ...base, dimensions: [dim], rowLimit: 5000 }),
        client.searchAnalytics(site, { ...p2, ...base, dimensions: [dim], rowLimit: 5000 }),
      ]);
      const a = totalsFromRows(t1);
      const b = totalsFromRows(t2);

      const map2 = new Map<string, AnalyticsRow>(r2.map((r) => [r.keys?.[0] ?? "", r]));
      const map1 = new Map<string, AnalyticsRow>(r1.map((r) => [r.keys?.[0] ?? "", r]));
      const keys = new Set([...map1.keys(), ...map2.keys()]);
      const diffs = [...keys].map((k) => {
        const x = map1.get(k);
        const y = map2.get(k);
        return { key: k, now: x, before: y, delta: (x?.clicks ?? 0) - (y?.clicks ?? 0) };
      });

      const row = (d: (typeof diffs)[number]) => [
        d.key,
        fmtInt(d.now?.clicks ?? 0),
        fmtInt(d.before?.clicks ?? 0),
        `${d.delta > 0 ? "+" : ""}${fmtInt(d.delta)}`,
        d.now ? fmtPos(d.now.position) : "—",
        d.before ? fmtPos(d.before.position) : "—",
      ];
      const headers = [dim, "Clicks P1", "Clicks P2", "Δ clicks", "Pos P1", "Pos P2"];
      const gains = diffs.filter((d) => d.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, limit);
      const losses = diffs.filter((d) => d.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, limit);
      const newItems = diffs.filter((d) => d.now && !d.before).length;
      const lostItems = diffs.filter((d) => !d.now && d.before).length;

      return [
        `Property: ${site} · P1 ${p1.startDate} → ${p1.endDate} vs P2 ${p2.startDate} → ${p2.endDate} · by ${dim}`,
        "",
        table(
          ["Metric", "P1", "P2", "Change"],
          [
            ["Clicks", fmtInt(a.clicks), fmtInt(b.clicks), fmtDelta(a.clicks, b.clicks)],
            ["Impressions", fmtInt(a.impressions), fmtInt(b.impressions), fmtDelta(a.impressions, b.impressions)],
            ["CTR", fmtPct(a.ctr), fmtPct(b.ctr), fmtDelta(a.ctr, b.ctr, "pct")],
            ["Avg. position", fmtPos(a.position), fmtPos(b.position), fmtDelta(a.position, b.position, "pos")],
          ],
        ),
        "",
        `New ${dim === "query" ? "queries" : "pages"} in P1 (not in P2 top 5000): ${newItems} · Lost (in P2, not in P1): ${lostItems}`,
        "",
        "Top gains:",
        table(headers, gains.map(row)),
        "",
        "Top losses:",
        table(headers, losses.map(row)),
      ].join("\n");
    },
  );

  // 5. get_search_by_page_query
  register(
    "get_search_by_page_query",
    {
      title: "Queries for a page / pages for a query",
      description:
        "Give page_url to get the queries that bring traffic to that page, or query to get the pages that rank for it.",
      inputSchema: {
        site_url: siteUrl,
        page_url: z.string().optional().describe("Exact page URL."),
        query: z.string().optional().describe("Exact search query."),
        start_date: startDate,
        end_date: endDate,
        days,
        search_type: searchType,
        row_limit: z.number().int().min(1).max(5000).optional().describe("Default 50."),
      },
    },
    async (args, client) => {
      if (!args.page_url === !args.query) throw new Error("Provide exactly one of page_url or query.");
      const site = await client.resolveSite(args.site_url);
      const range = resolveRange(args);
      const byPage = Boolean(args.page_url);
      const rows = await client.searchAnalytics(site, {
        ...range,
        type: args.search_type,
        dimensions: [byPage ? "query" : "page"],
        filters: [
          byPage
            ? { dimension: "page", operator: "equals", expression: args.page_url as string }
            : { dimension: "query", operator: "equals", expression: args.query as string },
        ],
        rowLimit: args.row_limit ?? 50,
      });
      return (
        `Property: ${site} · ${range.startDate} → ${range.endDate} · ${byPage ? `queries for page ${args.page_url}` : `pages for query "${args.query}"`}\n\n` +
        table([byPage ? "query" : "page", ...METRIC_HEADERS], rows.map((r) => [r.keys?.[0] ?? "", ...rowMetrics(r)]))
      );
    },
  );

  // 6. inspect_url
  register(
    "inspect_url",
    {
      title: "Inspect URL",
      description:
        "Google's index status for one URL: verdict, coverage, last crawl, canonicals, robots.txt, mobile usability and rich results. " +
        "Quota: about 2,000 inspections per property per day.",
      inputSchema: {
        site_url: siteUrl,
        url: z.url().describe("Full URL to inspect; must belong to the property."),
        language_code: z.string().optional().describe("Language for messages, e.g. es-ES. Default en-US."),
      },
    },
    async (args, client) => {
      const site = await client.resolveSite(args.site_url);
      const r = await client.inspectUrl(site, args.url, args.language_code);
      const s = r.indexStatusResult ?? {};
      const lines = [
        `URL: ${args.url}`,
        `Property: ${site}`,
        "",
        `- Verdict: ${s.verdict ?? "—"}`,
        `- Coverage: ${s.coverageState ?? "—"}`,
        `- Indexing allowed: ${s.indexingState ?? "—"}`,
        `- robots.txt: ${s.robotsTxtState ?? "—"}`,
        `- Page fetch: ${s.pageFetchState ?? "—"}`,
        `- Last crawl: ${s.lastCrawlTime ?? "—"} (${s.crawledAs ?? "—"})`,
        `- User canonical: ${s.userCanonical ?? "—"}`,
        `- Google canonical: ${s.googleCanonical ?? "—"}${
          s.googleCanonical && s.userCanonical && s.googleCanonical !== s.userCanonical ? " ⚠ differs from user canonical" : ""
        }`,
        `- Sitemaps: ${s.sitemap?.join(", ") || "—"}`,
        `- Referring URLs: ${s.referringUrls?.slice(0, 5).join(", ") || "—"}`,
        `- Mobile usability: ${r.mobileUsabilityResult?.verdict ?? "—"}${
          r.mobileUsabilityResult?.issues?.length
            ? ` (${r.mobileUsabilityResult.issues.map((i) => i.message ?? i.issueType).join("; ")})`
            : ""
        }`,
        `- Rich results: ${r.richResultsResult?.verdict ?? "—"}${
          r.richResultsResult?.detectedItems?.length
            ? ` (${r.richResultsResult.detectedItems.map((d) => d.richResultType).join(", ")})`
            : ""
        }`,
      ];
      if (r.inspectionResultLink) lines.push("", `Open in Search Console: ${r.inspectionResultLink}`);
      return lines.join("\n");
    },
  );

  // 7. batch_url_inspection
  register(
    "batch_url_inspection",
    {
      title: "Inspect several URLs",
      description:
        "Inspects up to 20 URLs and returns a summary table (verdict, coverage, last crawl, canonical mismatch). " +
        "Each URL counts against the ~2,000/day per-property inspection quota.",
      inputSchema: {
        site_url: siteUrl,
        urls: z.array(z.url()).min(1).max(20),
        language_code: z.string().optional(),
      },
    },
    async (args, client) => {
      const site = await client.resolveSite(args.site_url);
      const results = await mapConcurrent(args.urls, 4, async (url) => {
        try {
          const r = await client.inspectUrl(site, url, args.language_code);
          const s = r.indexStatusResult ?? {};
          const mismatch = s.googleCanonical && s.userCanonical && s.googleCanonical !== s.userCanonical;
          return [
            url,
            s.verdict ?? "—",
            s.coverageState ?? "—",
            s.lastCrawlTime?.slice(0, 10) ?? "—",
            mismatch ? `⚠ ${s.googleCanonical}` : "ok",
          ];
        } catch (err) {
          return [url, "ERROR", err instanceof Error ? err.message : String(err), "—", "—"];
        }
      });
      return (
        `Property: ${site} · ${args.urls.length} URLs\n\n` +
        table(["URL", "Verdict", "Coverage", "Last crawl", "Google canonical"], results)
      );
    },
  );

  // 8. list_sitemaps
  register(
    "list_sitemaps",
    {
      title: "List sitemaps",
      description: "Sitemaps submitted for a property, with last submission/download, errors, warnings and submitted URL counts.",
      inputSchema: { site_url: siteUrl },
    },
    async (args, client) => {
      const site = await client.resolveSite(args.site_url);
      const sitemaps = await client.listSitemaps(site);
      return (
        `Property: ${site} · ${sitemaps.length} sitemaps\n\n` +
        table(
          ["Sitemap", "Index", "Last submitted", "Last downloaded", "Pending", "Errors", "Warnings", "Submitted URLs"],
          sitemaps.map((s) => [
            s.path,
            s.isSitemapsIndex ? "yes" : "no",
            s.lastSubmitted?.slice(0, 10) ?? "—",
            s.lastDownloaded?.slice(0, 10) ?? "—",
            s.isPending ? "yes" : "no",
            s.errors ?? "0",
            s.warnings ?? "0",
            s.contents?.map((c) => `${c.type}: ${c.submitted ?? "?"}`).join(", ") || "—",
          ]),
        )
      );
    },
  );

  // 9. get_sitemap_details
  register(
    "get_sitemap_details",
    {
      title: "Sitemap details",
      description: "Details of one submitted sitemap.",
      inputSchema: { site_url: siteUrl, sitemap_url: z.url().describe("Full sitemap URL as submitted.") },
    },
    async (args, client) => {
      const site = await client.resolveSite(args.site_url);
      const s = await client.getSitemap(site, args.sitemap_url);
      return [
        `Sitemap: ${s.path}`,
        `Property: ${site}`,
        "",
        `- Type: ${s.type ?? "—"}${s.isSitemapsIndex ? " (sitemap index)" : ""}`,
        `- Last submitted: ${s.lastSubmitted ?? "—"}`,
        `- Last downloaded: ${s.lastDownloaded ?? "—"}`,
        `- Pending processing: ${s.isPending ? "yes" : "no"}`,
        `- Errors: ${s.errors ?? "0"} · Warnings: ${s.warnings ?? "0"}`,
        "",
        table(
          ["Content type", "Submitted"],
          (s.contents ?? []).map((c) => [c.type, c.submitted ?? "—"]),
        ),
      ].join("\n");
    },
  );
}
