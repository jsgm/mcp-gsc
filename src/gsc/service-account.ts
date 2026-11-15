import { cleanValue } from "../config";
import { bytesToBase64Url, stringToBase64Url } from "../util/base64url";

const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GSC_READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseServiceAccount(json: string): ServiceAccountKey {
  let data: unknown;
  try {
    data = JSON.parse(cleanValue(json));
  } catch {
    throw new Error("GSC_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  const sa = data as Partial<ServiceAccountKey>;
  if (!sa || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") {
    throw new Error("GSC_SERVICE_ACCOUNT_JSON must contain client_email and private_key.");
  }
  return { client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri };
}

function pemToPkcs8(pem: string): ArrayBuffer {
  // Secrets pasted by hand sometimes keep the literal "\n" sequences.
  const normalized = pem.replace(/\\n/g, "\n");
  const b64 = normalized
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Builds the signed JWT assertion for the OAuth 2.0 JWT bearer grant (RFC 7523). */
export async function signServiceAccountJwt(
  sa: ServiceAccountKey,
  scope: string,
  issuedAt: number,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope,
    aud: sa.token_uri ?? DEFAULT_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const signingInput = `${stringToBase64Url(JSON.stringify(header))}.${stringToBase64Url(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

// Per-isolate cache: tokens last one hour, so most calls skip the exchange.
let cachedToken: { email: string; token: string; expiresAt: number } | null = null;

export async function getGoogleAccessToken(
  serviceAccountJson: string,
  scope: string = GSC_READONLY_SCOPE,
): Promise<string> {
  const sa = parseServiceAccount(serviceAccountJson);
  const now = Date.now();
  if (cachedToken && cachedToken.email === sa.client_email && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.token;
  }

  const assertion = await signServiceAccountJwt(sa, scope, Math.floor(now / 1000));
  const res = await fetch(sa.token_uri ?? DEFAULT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    email: sa.client_email,
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return data.access_token;
}
