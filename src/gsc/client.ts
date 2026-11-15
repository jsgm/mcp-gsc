import { getGoogleAccessToken, parseServiceAccount } from "./service-account";

const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const INSPECTION = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export interface AnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface AnalyticsFilter {
  dimension: string;
  operator: string;
  expression: string;
}

export interface AnalyticsQuery {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  type?: string;
  filters?: AnalyticsFilter[];
  rowLimit?: number;
  startRow?: number;
  dataState?: "final" | "all";
  aggregationType?: "auto" | "byPage" | "byProperty";
}

export interface SitemapContent {
  type: string;
  submitted?: string;
  indexed?: string;
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings?: string;
  errors?: string;
  contents?: SitemapContent[];
}

export interface InspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
    sitemap?: string[];
    referringUrls?: string[];
  };
  mobileUsabilityResult?: { verdict?: string; issues?: { issueType?: string; message?: string }[] };
  richResultsResult?: {
    verdict?: string;
    detectedItems?: { richResultType?: string; items?: { name?: string; issues?: { issueMessage?: string; severity?: string }[] }[] }[];
  };
  ampResult?: { verdict?: string };
}

export class GscApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GscApiError";
  }
}

const SITES_TTL_MS = 5 * 60_000;
let sitesCache: { email: string; sites: SiteEntry[]; at: number } | null = null;

export class GscClient {
  readonly serviceAccountEmail: string;

  constructor(private readonly serviceAccountJson: string) {
    this.serviceAccountEmail = parseServiceAccount(serviceAccountJson).client_email;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await getGoogleAccessToken(this.serviceAccountJson);
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        // keep the status text
      }
      throw new GscApiError(res.status, message);
    }
    return (await res.json()) as T;
  }

  async listSites(force = false): Promise<SiteEntry[]> {
    const now = Date.now();
    if (
      !force &&
      sitesCache &&
      sitesCache.email === this.serviceAccountEmail &&
      now - sitesCache.at < SITES_TTL_MS
    ) {
      return sitesCache.sites;
    }
    const data = await this.request<{ siteEntry?: SiteEntry[] }>(`${WEBMASTERS}/sites`);
    const sites = (data.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
    sitesCache = { email: this.serviceAccountEmail, sites, at: now };
    return sites;
  }

  /**
   * Accepts "sc-domain:example.com", "https://example.com/" or a bare "example.com"
   * and returns the exact property identifier the service account has access to.
   */
  async resolveSite(input: string): Promise<string> {
    const value = input.trim();
    const sites = await this.listSites();
    const urls = sites.map((s) => s.siteUrl);
    if (urls.includes(value)) return value;

    const bare = value
      .replace(/^sc-domain:/, "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .toLowerCase();
    const withSlash = /^https?:\/\//.test(value) && !value.endsWith("/") ? `${value}/` : value;
    const candidates = [
      withSlash,
      `sc-domain:${bare}`,
      `sc-domain:${bare.replace(/^www\./, "")}`,
      `https://${bare}/`,
      `https://www.${bare.replace(/^www\./, "")}/`,
      `http://${bare}/`,
      `http://www.${bare.replace(/^www\./, "")}/`,
    ];
    for (const c of candidates) if (urls.includes(c)) return c;

    throw new GscApiError(
      404,
      `The service account ${this.serviceAccountEmail} has no access to a property matching "${input}". ` +
        `Available properties: ${urls.length ? urls.join(", ") : "(none)"}. ` +
        `Add the service account as a user in Search Console → Settings → Users and permissions.`,
    );
  }

  async searchAnalytics(siteUrl: string, q: AnalyticsQuery): Promise<AnalyticsRow[]> {
    const body: Record<string, unknown> = {
      startDate: q.startDate,
      endDate: q.endDate,
      dimensions: q.dimensions ?? [],
      type: q.type ?? "web",
      rowLimit: Math.min(q.rowLimit ?? 1000, 25000),
      startRow: q.startRow ?? 0,
      dataState: q.dataState ?? "final",
    };
    if (q.aggregationType) body.aggregationType = q.aggregationType;
    if (q.filters?.length) body.dimensionFilterGroups = [{ groupType: "and", filters: q.filters }];

    const data = await this.request<{ rows?: AnalyticsRow[] }>(
      `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return data.rows ?? [];
  }

  async listSitemaps(siteUrl: string): Promise<Sitemap[]> {
    const data = await this.request<{ sitemap?: Sitemap[] }>(
      `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
    );
    return data.sitemap ?? [];
  }

  async getSitemap(siteUrl: string, feedpath: string): Promise<Sitemap> {
    return this.request<Sitemap>(
      `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
    );
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string, languageCode = "en-US"): Promise<InspectionResult> {
    const data = await this.request<{ inspectionResult?: InspectionResult }>(INSPECTION, {
      method: "POST",
      body: JSON.stringify({ inspectionUrl, siteUrl, languageCode }),
    });
    return data.inspectionResult ?? {};
  }
}
