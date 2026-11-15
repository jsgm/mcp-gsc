import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;

  // Google
  GSC_SERVICE_ACCOUNT_JSON: string;

  // Cloudflare Access for SaaS (OIDC)
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  CF_ACCESS_AUTHORIZATION_ENDPOINT: string;
  CF_ACCESS_TOKEN_ENDPOINT: string;
  CF_ACCESS_KEY_ENDPOINT: string;

  // Optional comma-separated allowlist checked after Access login.
  ALLOWED_EMAILS?: string;
}

/** Env as seen by the default (non-API) handler: the OAuth provider injects its helpers. */
export type HandlerEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** Identity of the authenticated user, stored with the OAuth grant and passed to the MCP agent. */
export type Props = {
  sub: string;
  email: string;
  name?: string;
};
