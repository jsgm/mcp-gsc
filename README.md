# mcp-gsc

**English** · [Español](README.es.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jsgm/mcp-gsc)

Remote MCP server for **Google Search Console** on **Cloudflare Workers**, for use from Claude and ChatGPT (web, desktop and Claude Code).

- **One service account per deployment**, with access to every property you add it to.
- **OAuth + Cloudflare Access**: Claude and ChatGPT connect over OAuth (the only option their connectors support) and Cloudflare Access decides who can sign in.
- **Read-only**, no Docker, no servers: `wrangler deploy` and you're done.

## How it works

```
Claude / ChatGPT ──OAuth 2.1──▶ Worker ──service account JWT──▶ Search Console API
                                  │
                                  └─ login (browser only) ──▶ Cloudflare Access (OIDC)
```

1. Add `https://<your-worker>/mcp` as an OAuth connector in Claude or ChatGPT.
2. The Worker shows a confirmation page, then the Cloudflare Access login (one-time email code, Google, GitHub…).
3. If your email is allowed in Access, the Worker issues its own tokens to the MCP client.
4. The tools query Search Console with the service account.

Cloudflare Access does **not** sit in front of `/mcp`: it only takes part in the login. MCP traffic is protected by the tokens the Worker issues ([`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)).

## Tools

| Tool | What it does |
|---|---|
| `list_properties` | Properties the service account can access |
| `get_search_analytics` | Clicks, impressions, CTR and position by dimension, with filters and dates |
| `get_performance_overview` | Totals vs the previous period, plus the daily trend |
| `compare_search_periods` | Two periods by query or page: biggest gains, losses, new and lost items |
| `get_search_by_page_query` | Queries for a URL, or URLs for a query |
| `inspect_url` | Index status, canonical, crawl, robots.txt, mobile usability, rich results |
| `batch_url_inspection` | Up to 20 URLs in one summary table |
| `list_sitemaps` | Submitted sitemaps, errors, warnings and submitted URLs |
| `get_sitemap_details` | Details of one sitemap |

A property can be given as `sc-domain:example.com`, `https://www.example.com/` or just `example.com`; the server resolves it against the accessible properties.

## Setup

### 1. Google service account

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
2. **APIs & Services → Library**, search for **Google Search Console API** and enable it.
3. **IAM & Admin → Service Accounts → Create service account** (no roles needed).
4. On the new account: **Keys → Add key → JSON**. Keep the file safe; do not commit it.
5. In [Search Console](https://search.google.com/search-console), on **each property**: **Settings → Users and permissions → Add user**, with the service account email (`...@...iam.gserviceaccount.com`) and **Restricted** (enough to read) or **Full** permission.

To add a site later, just repeat step 5; the Worker needs no changes.

### 2. Cloudflare Access application (OIDC)

The Worker URL will be `https://<worker-name>.<your-subdomain>.workers.dev` (default name `mcp-gsc`; your subdomain is shown under **Workers & Pages** in the Cloudflare dashboard). You can create the Access application before deploying, using that expected URL.

In the **Cloudflare Zero Trust** dashboard (the first time, you'll be asked to pick a team name; the free plan covers up to 50 users):

1. **Access → Applications → Add an application → SaaS**.
2. Name: `mcp-gsc`. Authentication protocol: **OIDC**.
3. **Redirect URLs**: `https://mcp-gsc.<your-subdomain>.workers.dev/callback`
   (for local development, also add `http://localhost:8787/callback`).
4. **Scopes**: `openid`, `email`, `profile`.
5. Save and copy the **Client ID**, **Client secret**, **Authorization endpoint**, **Token endpoint** and **Key endpoint** (JWKS).
6. **Policies**: create an *Allow* policy that includes the emails (or domain) allowed to use the server.
7. **Login methods**: choose the methods (one-time email code, Google, GitHub…).

Exact dashboard labels may vary slightly between Zero Trust versions.

### 3. Deploy

#### Option A: "Deploy to Cloudflare" button (recommended)

1. Click the button at the top of this document.
2. Cloudflare copies the repository to your GitHub or GitLab, creates the Worker and the KV namespace, and sets up automatic deploys on every push.
3. It asks for the 6 secrets, with a description of where to find each one:
   - `GSC_SERVICE_ACCOUNT_JSON`: paste the full contents of the service account JSON.
   - `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `CF_ACCESS_AUTHORIZATION_ENDPOINT`, `CF_ACCESS_TOKEN_ENDPOINT`, `CF_ACCESS_KEY_ENDPOINT`: the values from step 2.
4. If you change the Worker name in the form, update the Access application's Redirect URL to match.

If you don't have the Access application yet, you can enter `pending` for its secrets and change them later in **Workers & Pages → mcp-gsc → Settings → Variables and Secrets**. The MCP server won't work until then, because the login depends on them.

#### Option B: manually with Wrangler

```bash
git clone https://github.com/jsgm/mcp-gsc && cd mcp-gsc
npm install
npx wrangler login
npx wrangler deploy        # creates the KV namespace automatically → https://mcp-gsc.<your-subdomain>.workers.dev

npx wrangler secret put GSC_SERVICE_ACCOUNT_JSON < path/to/service-account.json
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
npx wrangler secret put CF_ACCESS_AUTHORIZATION_ENDPOINT
npx wrangler secret put CF_ACCESS_TOKEN_ENDPOINT
npx wrangler secret put CF_ACCESS_KEY_ENDPOINT
```

If your Wrangler version doesn't create the KV namespace automatically, create it with `npx wrangler kv namespace create OAUTH_KV` and add its `id` to `wrangler.jsonc`.

#### Optional: change which clients can connect

The server only issues tokens to these redirect hosts by default: `claude.ai`, `claude.com`, `chatgpt.com`, `openai.com`, `grok.com`, `x.ai`, `console.x.ai`, `www.perplexity.ai`, `perplexity.ai`, `enterprise.perplexity.ai`, `enterprise.perplexity.com`, `localhost`, `127.0.0.1`, `[::1]`. That covers Claude, ChatGPT, Grok, Perplexity and local clients such as Claude Code.

To change the list, set `ALLOWED_REDIRECT_HOSTS` (comma-separated hostnames) as a Worker variable; it replaces the default list. Set it to `*` to accept any client that registers (the confirmation page then warns when the destination is not a known client).

### 4. Connect the clients

**Claude (web or desktop):** Settings → Connectors → *Add custom connector* → URL `https://mcp-gsc.<your-subdomain>.workers.dev/mcp`. Connecting opens the login.

**ChatGPT:** Settings → Apps & Connectors → Advanced → enable *Developer mode* → *Create*, with the same URL and **OAuth** authentication. (Requires a plan with developer mode.)

**Claude Code:**

```bash
claude mcp add --transport http gsc https://mcp-gsc.<your-subdomain>.workers.dev/mcp
```

Try: *"List my Search Console properties"*.

## A second deployment (e.g. personal)

Same code, another service account and another Worker.

The easiest way is to click the "Deploy to Cloudflare" button again from the right Cloudflare account, with a different Worker name (e.g. `mcp-gsc-personal`). Manually:

```bash
cp wrangler.jsonc wrangler.personal.jsonc   # change "name" (e.g. mcp-gsc-personal)
npx wrangler deploy -c wrangler.personal.jsonc   # creates its own KV namespace
npx wrangler secret put GSC_SERVICE_ACCOUNT_JSON -c wrangler.personal.jsonc < personal.json
# ...remaining secrets with -c wrangler.personal.jsonc
```

Create another Access application (or add its `/callback` to the existing one) and connect it as another connector. Ideally, each credential lives in its owner's Cloudflare account (company or personal).

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the values
npm run dev                      # http://localhost:8787
npx @modelcontextprotocol/inspector   # connect to http://localhost:8787/mcp
```

### Updating dependencies

The server uses `createMcpHandler` from `agents` with the MCP SDK v2 (`@modelcontextprotocol/server`): stateless, no Durable Objects. `agents` requires an **exact** version of `@modelcontextprotocol/server` and doesn't install it for you, so both are pinned in `package.json`. If you update `agents`, check the version it expects:

```bash
npm view agents@<version> peerDependencies
```

and use that same version of `@modelcontextprotocol/server`.

## Security

- **Read-only**: the Google scope is `webmasters.readonly` and no tool modifies anything.
- **The service account sees everything it's been granted**: anyone who passes the Access login sees those properties. Keep the Access policy tight.
- **Confirmation page**: users approve each new connection before logging in, and the login state is bound to a browser cookie, so no other site can complete an authorization on your behalf. The page prominently shows the domain the tokens will go to and warns if it's not a known client, because the application name is chosen by whoever registers it and is not verified.
- **Allowed clients**: anyone can register an OAuth client (MCP requires it). To stop someone from tricking a user with an authorization link that points to their own domain, tokens are only issued to a default list of known clients (Claude, ChatGPT, Grok, Perplexity, loopback). Adjust it with `ALLOWED_REDIRECT_HOSTS`.
- **No writes before approval**: visiting `/authorize` writes nothing to KV; state is only stored when the user clicks *Continue*. Client registration (`/register`) does write to KV and is open; on the Workers KV free plan (1,000 writes per day) abuse could exhaust the daily quota. If that's a concern and you use a custom domain, add a [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) for `/register`, `/authorize` and `/token`.
- **Third-party data**: search queries and URLs returned by Search Console are written by other people. The tools mark their output as untrusted data so the model doesn't follow instructions it may contain, but be careful when combining this connector with others that can write or send things.
- **Revoking someone's access**: remove them from the Access policy to block new logins. Existing authorizations are stored in KV (`OAUTH_KV`); to cut them off immediately, delete their grants (`npx wrangler kv key list --binding OAUTH_KV --prefix "grant:"` and `npx wrangler kv key delete`).
- **Logs**: each call logs user, tool, duration and result (visible under *Workers → Logs*), with no Search Console data. Unexpected login errors show only a reference; details stay in the logs.
- **Dependencies**: after the first `npm install`, commit `package-lock.json` so every build uses exactly the same versions.

## Limits

- **URL inspection**: about 2,000 per day per property (and 600 per minute), according to Google.
- **Search Analytics**: at most 25,000 rows per request; data for the last 16 months, with a 2–3 day delay.
- **Workers free plan**: about 50 subrequests per invocation; enough for every tool as implemented (batch inspection is capped at 20 URLs).

## License

MIT
