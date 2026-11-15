import { base64UrlToBytes, base64UrlToString } from "../util/base64url";

export interface IdTokenClaims {
  iss?: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  name?: string;
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
}

/**
 * Verifies an RS256 ID token against a JWKS document.
 * Checks signature, audience, expiry and (if given) nonce.
 */
export async function verifyIdToken(
  idToken: string,
  jwks: { keys: Jwk[] },
  expected: { audience: string; nonce?: string; now?: number },
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token.");
  const [h, p, s] = parts;

  const header = JSON.parse(base64UrlToString(h)) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`Unsupported ID token algorithm: ${header.alg}`);

  const candidates = jwks.keys.filter((k) => k.kty === "RSA" && (!header.kid || k.kid === header.kid));
  if (!candidates.length) throw new Error("No matching key in JWKS.");

  const data = new TextEncoder().encode(`${h}.${p}`);
  const signature = base64UrlToBytes(s) as BufferSource;
  let valid = false;
  for (const jwk of candidates) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data)) {
      valid = true;
      break;
    }
  }
  if (!valid) throw new Error("Invalid ID token signature.");

  const claims = JSON.parse(base64UrlToString(p)) as IdTokenClaims;
  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) throw new Error("ID token audience mismatch.");
  if (typeof claims.exp !== "number" || claims.exp + 60 < now) throw new Error("ID token expired.");
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) throw new Error("ID token nonce mismatch.");
  if (!claims.sub) throw new Error("ID token has no subject.");
  return claims;
}
