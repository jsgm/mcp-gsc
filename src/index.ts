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
) => ExportedHandler<Env>;

/** Protected MCP endpoint (Streamable HTTP). Only reached with a valid OAuth token. */
const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: accessHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
