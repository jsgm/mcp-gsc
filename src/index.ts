import * as oauthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { accessHandler } from "./auth/access-handler";
import type { Env } from "./env";
import { createServer } from "./mcp/server";

// The library has exported OAuthProvider both as default and as a named export
// across versions; accept either.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OAuthProvider = ((oauthProvider as any).OAuthProvider ?? (oauthProvider as any).default) as new (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any,
) => Required<Pick<ExportedHandler<Env>, "fetch">>;

const MCP_PATH = "/mcp";

/** Protected MCP endpoint (Streamable HTTP). Only reached with a valid OAuth token. */
const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};

/**
 * workers-oauth-provider >= 1.0 requires the canonical HTTPS URI of the protected
 * resource (it becomes the token audience). It is derived from the request origin,
 * so the same code works on workers.dev or a custom domain without extra config.
 * One provider is built per origin and reused for the isolate's lifetime.
 */
const providers = new Map<string, InstanceType<typeof OAuthProvider>>();

function providerFor(origin: string): InstanceType<typeof OAuthProvider> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider({
      apiRoute: MCP_PATH,
      apiHandler: mcpHandler,
      defaultHandler: accessHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      resourceMetadata: {
        resource: `${origin}${MCP_PATH}`,
        authorization_servers: [origin],
        resource_name: "Google Search Console (mcp-gsc)",
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // URL.origin is already lowercased (scheme + host), as the library requires.
    const origin = new URL(request.url).origin;
    return Promise.resolve(providerFor(origin).fetch(request, env, ctx));
  },
};
