import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { HandlerEnv, Props } from "../env";
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

function allowedByList(env: HandlerEnv, email: string): boolean {
  const list = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length === 0 || list.includes(email.toLowerCase());
}

async function handleAuthorizeGet(request: Request, env: HandlerEnv): Promise<Response> {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!oauthReqInfo.clientId) return fail("Missing client_id.");

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!client) return fail("Unknown client.");
  if (!client.redirectUris.includes(oauthReqInfo.redirectUri)) return fail("Invalid redirect_uri for this client.");

  const stateId = randomId();
  const pending: PendingAuth = { oauthReqInfo, nonce: randomId(), approved: false };
  await env.OAUTH_KV.put(stateKey(stateId), JSON.stringify(pending), { expirationTtl: STATE_TTL_SECONDS });

  return htmlResponse(
    consentPage({
      clientName: client.clientName || client.clientId,
      clientUri: client.clientUri,
      redirectUri: oauthReqInfo.redirectUri,
      stateId,
    }),
    { headers: { "set-cookie": stateCookie(stateId, STATE_TTL_SECONDS) } },
  );
}

async function handleAuthorizePost(request: Request, env: HandlerEnv): Promise<Response> {
  const form = await request.formData();
  const stateId = String(form.get("state") ?? "");
  const cookie = readCookie(request, COOKIE);
  if (!stateId || !cookie || !timingSafeEqual(stateId, cookie)) {
    return fail("Login session expired or invalid. Start the connection again from your MCP client.");
  }

  const raw = await env.OAUTH_KV.get(stateKey(stateId));
  if (!raw) return fail("Login session expired. Start the connection again from your MCP client.");
  const pending = JSON.parse(raw) as PendingAuth;
  pending.approved = true;
  await env.OAUTH_KV.put(stateKey(stateId), JSON.stringify(pending), { expirationTtl: STATE_TTL_SECONDS });

  const authorize = new URL(env.CF_ACCESS_AUTHORIZATION_ENDPOINT);
  authorize.searchParams.set("client_id", env.CF_ACCESS_CLIENT_ID);
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
  // The cookie ties the callback to the browser that saw the consent page.
  if (!cookie || !timingSafeEqual(stateId, cookie)) return fail("Login session mismatch. Start again from your MCP client.");

  const raw = await env.OAUTH_KV.get(stateKey(stateId));
  if (!raw) return fail("Login session expired. Start the connection again from your MCP client.");
  await env.OAUTH_KV.delete(stateKey(stateId));
  const pending = JSON.parse(raw) as PendingAuth;
  if (!pending.approved) return fail("This login was not approved.");

  // Exchange the code with Cloudflare Access.
  const tokenRes = await fetch(env.CF_ACCESS_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: new URL("/callback", request.url).href,
      client_id: env.CF_ACCESS_CLIENT_ID,
      client_secret: env.CF_ACCESS_CLIENT_SECRET,
    }),
  });
  if (!tokenRes.ok) {
    console.log(JSON.stringify({ event: "access_token_error", status: tokenRes.status, body: (await tokenRes.text()).slice(0, 300) }));
    return fail("Could not complete the login with Cloudflare Access.", 502);
  }
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return fail("Cloudflare Access did not return an ID token.", 502);

  const jwksRes = await fetch(env.CF_ACCESS_KEY_ENDPOINT);
  if (!jwksRes.ok) return fail("Could not load Cloudflare Access signing keys.", 502);
  const jwks = (await jwksRes.json()) as { keys: { kty: string; kid?: string; n?: string; e?: string }[] };

  let claims;
  try {
    claims = await verifyIdToken(tokens.id_token, jwks, { audience: env.CF_ACCESS_CLIENT_ID, nonce: pending.nonce });
  } catch (err) {
    console.log(JSON.stringify({ event: "id_token_invalid", error: err instanceof Error ? err.message : String(err) }));
    return fail("Invalid identity token from Cloudflare Access.", 401);
  }

  const email = (claims.email ?? "").toLowerCase();
  if (!email) return fail("Your Cloudflare Access identity has no email.", 403);
  if (!allowedByList(env, email)) {
    console.log(JSON.stringify({ event: "login_denied", email }));
    return fail(`${email} is not allowed to use this server.`, 403);
  }

  const props: Props = { sub: claims.sub, email, name: claims.name };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthReqInfo,
    userId: claims.sub,
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
      console.log(JSON.stringify({ event: "handler_error", path: url.pathname, error: err instanceof Error ? err.message : String(err) }));
      return fail("Unexpected error during authorization.", 500);
    }
  },
};
