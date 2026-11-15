import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { accessHandler } from "./auth/access-handler";
import { GscMCP } from "./mcp/server";

export { GscMCP };

export default new OAuthProvider({
  apiHandlers: {
    // Streamable HTTP (current MCP transport) and legacy SSE for older clients.
    "/mcp": GscMCP.serve("/mcp"),
    "/sse": GscMCP.serveSSE("/sse"),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: accessHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
