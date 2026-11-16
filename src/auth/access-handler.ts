import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { HandlerEnv, Props } from "../env";
import { accessConfig, ConfigError } from "../config";
import { randomId } from "../util/base64url";
import { verifyIdToken } from "./oidc";
import { consentPage, errorPage, homePage, htmlResponse } from "./pages";

/**
 * Login flow (default handler of the OAuth provider):
 *
 *   GET  /authorize  MCP client starts OAuth → consent page (state kept in KV, bound to a cookie)
 *   POST /authorize  user approves → redirect to Cloudflare Access (OIDC)
 *   GET  /callback   Access returns → verify ID token → completeAuthorization → back to the client
 *
 * The /mcp endpoint itself is protected by the tokens issued by workers-oauth-provider,
 * so Cloudflare Access never sits in front of the MCP traffic.
 */

const STATE_TTL_SECONDS = 600;
const COOKIE = "__Host-mcp_gsc_state";

interface PendingAuth {
  oauthReqInfo: AuthRequest;
  nonce: string;
  approved: boolean;
}

const stateKey = (id: string) => `login_state:${id}`;

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function stateCookie(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function fail(message: string, status = 400): Response {
  return htmlResponse(errorPage(message), { status, headers: { "set-cookie": stateCookie("", 0) } });
}

/**
 * Default OAuth redirect hosts: well-known MCP clients (Claude, ChatGPT/OpenAI, Grok/xAI,
 * Perplexity) and loopback for local clients such as Claude Code. Override with
 * ALLOWED_REDIRECT_HOSTS (comma-separated hostnames), or "*" to allow any registered redirect.
 */
export const DEFAULT_REDIRECT_HOSTS = [
  "claude.ai",
  "claude.com",
  "chatgpt.com",
  "openai.com",
  "grok.com",
  "x.ai",
  "console.x.ai",
  "www.perplexity.ai",
  "perplexity.ai",
  "enterprise.perplexity.ai",
  "enterprise.perplexity.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
];

function redirectHostname(uri: string): string {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isKnownRedirect(uri: string): boolean {
  return DEFAULT_REDIRECT_HOSTS.includes(redirectHostname(uri));
}

/** Effective allowlist: ALLOWED_REDIRECT_HOSTS if set, otherwise the defaults. "*" disables the check. */
function allowedRedirectHosts(env: HandlerEnv): string[] | "*" {
  const raw = (env.ALLOWED_REDIRECT_HOSTS ?? "").trim().replace(/^(['"])(.*)\1$/s, "$2").trim();
  if (raw === "*") return "*";
  const list = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_REDIRECT_HOSTS;
}

function redirectAllowed(env: HandlerEnv, uri: string): boolean {
  const allowed = allowedRedirectHosts(env);
  return allowed === "*" || allowed.includes(redirectHostname(uri));
}

/** Parses and validates the OAuth request carried in `request`'s query string. */
async function validatedAuthRequest(request: Request, env: HandlerEnv) {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!oauthReqInfo.clientId) throw new AuthFlowError("Missing client_id.");
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!client) throw new AuthFlowError("Unknown client.");
  if (!client.redirectUris.includes(oauthReqInfo.redirectUri)) throw new AuthFlowError("Invalid redirect_uri for this client.");
  if (!redirectAllowed(env, oauthReqInfo.redirectUri)) {
    throw new AuthFlowError(`Redirects to ${redirectHostname(oauthReqInfo.redirectUri) || oauthReqInfo.redirectUri} are not allowed on this server.`, 403);
  }
  return { oauthReqInfo, client };
}

class AuthFlowError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Origin of the Access authorization endpoint, for the consent page's CSP form-action (null if not configured yet). */
function accessOrigin(env: HandlerEnv): string | null {
  try {
    return new URL(accessConfig(env).authorizationEndpoint).origin;
  } catch {
    return null;
  }
}

async function handleAuthorizeGet(request: Request, env: HandlerEnv): Promise<Response> {
  const { oauthReqInfo, client } = await validatedAuthRequest(request, env);

  // Nothing is stored yet: unauthenticated visitors must not be able to create KV writes.
  // The random state lives only in an HttpOnly cookie and the form; the OAuth request is
  // re-parsed and re-validated from the original query string when the user approves.
  const stateId = randomId();
  const query = new URL(request.url).search;
  const formAction = accessOrigin(env);

  return htmlResponse(
    consentPage({
      clientName: client.clientName || client.clientId,
      clientUri: client.clientUri,
      redirectUri: oauthReqInfo.redirectUri,
      redirectHost: redirectHostname(oauthReqInfo.redirectUri),
      knownClient: isKnownRedirect(oauthReqInfo.redirectUri),
      stateId,
      query,
    }),
    {
      headers: { "set-cookie": stateCookie(stateId, STATE_TTL_SECONDS) },
      // Chrome and Safari apply form-action to the redirect that follows the POST.
      extraFormAction: formAction ?? undefined,
    },
  );
}

async function handleAuthorizePost(request: Request, env: HandlerEnv): Promise<Response> {
  const form = await request.formData();
  const stateId = String(form.get("state") ?? "");
  const query = String(form.get("query") ?? "");
  const cookie = readCookie(request, COOKIE);
  if (!stateId || !cookie || !timingSafeEqual(stateId, cookie)) {
    return fail("Login session expired or invalid. Start the connection again from your MCP client.");
  }
  if (!query.startsWith("?") || query.length > 8192) return fail("Invalid authorization request.");

  // Re-parse and re-validate exactly what was shown on the consent page.
  const original = new Request(new URL(`/authorize${query}`, request.url).href, { method: "GET" });
  const { oauthReqInfo } = await validatedAuthRequest(original, env);
  const cfg = accessConfig(env);

  const pending: PendingAuth = { oauthReqInfo, nonce: randomId(), approved: true };
  await env.OAUTH_KV.put(stateKey(stateId), JSON.stringify(pending), { expirationTtl: STATE_TTL_SECONDS });

  const authorize = new URL(cfg.authorizationEndpoint);
  authorize.searchParams.set("client_id", cfg.clientId);
  authorize.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", stateId);
  authorize.searchParams.set("nonce", pending.nonce);

  return new Response(null, { status: 302, headers: { location: authorize.href, "cache-control": "no-store" } });
}

async function handleCallback(request: Request, env: HandlerEnv): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return fail(`Cloudflare Access returned an error: ${error}`);

  const code = url.searchParams.get("code");
  const stateId = url.searchParams.get("state");
  const cookie = readCookie(request, COOKIE);
  if (!code || !stateId) return fail("Missing code or state.");
  const cfg = accessConfig(env);
  // The cookie ties the callback to the browser that saw the consent page.
  if (!cookie || !timingSafeEqual(stateId, cookie)) return fail("Login session mismatch. Start again from your MCP client.");

  const raw = await env.OAUTH_KV.get(stateKey(stateId));
  if (!raw) return fail("Login session expired. Start the connection again from your MCP client.");
  await env.OAUTH_KV.delete(stateKey(stateId));
  const pending = JSON.parse(raw) as PendingAuth;
  if (!pending.approved) return fail("This login was not approved.");

  // Exchange the code with Cloudflare Access.
  const tokenRes = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: new URL("/callback", request.url).href,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!tokenRes.ok) {
    const body = (await tokenRes.text()).slice(0, 300);
    console.log(JSON.stringify({ event: "access_token_error", status: tokenRes.status, body }));
    return fail(
      `Cloudflare Access rejected the code exchange (${tokenRes.status}). ` +
        "Check CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET and CF_ACCESS_TOKEN_ENDPOINT, and that the Access application's redirect URL is " +
        new URL("/callback", request.url).href,
      502,
    );
  }
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return fail("Cloudflare Access did not return an ID token.", 502);

  const jwksRes = await fetch(cfg.keyEndpoint);
  if (!jwksRes.ok) return fail(`Could not load Cloudflare Access signing keys (${jwksRes.status}). Check CF_ACCESS_KEY_ENDPOINT.`, 502);
  const jwks = (await jwksRes.json()) as { keys: { kty: string; kid?: string; n?: string; e?: string }[] };

  let claims;
  try {
    claims = await verifyIdToken(tokens.id_token, jwks, { audience: cfg.clientId, nonce: pending.nonce });
  } catch (err) {
    console.log(JSON.stringify({ event: "id_token_invalid", error: err instanceof Error ? err.message : String(err) }));
    return fail("Invalid identity token from Cloudflare Access.", 401);
  }

  const email = (claims.email ?? "").toLowerCase();
  // Who may sign in is enforced by the Cloudflare Access policy.
  if (!email) return fail("Your Cloudflare Access identity has no email.", 403);

  const props: Props = { sub: claims.sub, email, name: claims.name };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthReqInfo,
    // workers-oauth-provider >= 1.2 does not allow ":" in user IDs.
    userId: claims.sub.replace(/:/g, "_"),
    metadata: { label: email },
    scope: pending.oauthReqInfo.scope,
    props,
  });
  console.log(JSON.stringify({ event: "login_ok", email, client: pending.oauthReqInfo.clientId }));

  return new Response(null, {
    status: 302,
    headers: { location: redirectTo, "set-cookie": stateCookie("", 0), "cache-control": "no-store" },
  });
}

export const accessHandler = {
  async fetch(request: Request, env: HandlerEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") return await handleAuthorizeGet(request, env);
      if (url.pathname === "/authorize" && request.method === "POST") return await handleAuthorizePost(request, env);
      if (url.pathname === "/callback" && request.method === "GET") return await handleCallback(request, env);
      if (url.pathname === "/" && request.method === "GET") return htmlResponse(homePage(url.origin));
      return new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof AuthFlowError) return fail(err.message, err.status);
      const message = err instanceof Error ? err.message : String(err);
      const ref = randomId(6);
      console.log(JSON.stringify({ event: "handler_error", ref, path: url.pathname, error: message }));
      // Config errors never contain secret values, so they are safe (and useful) to show.
      if (err instanceof ConfigError) return fail(`Server misconfiguration: ${message}`, 500);
      return fail(`Unexpected error during authorization (ref ${ref}). Details are in the Worker logs.`, 500);
    }
  },
};
