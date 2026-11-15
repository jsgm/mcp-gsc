import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import type { Env, Props } from "../env";
import { GscClient } from "../gsc/client";
import { registerTools } from "./tools";

/**
 * Builds a fresh MCP server for each request (stateless, MCP SDK v2).
 * The authenticated user's props come from workers-oauth-provider via getMcpAuthContext().
 */
export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "mcp-gsc", version: "0.2.0" });
  let client: GscClient | undefined;
  registerTools(server, {
    client: () => (client ??= new GscClient(env.GSC_SERVICE_ACCOUNT_JSON)),
    user: () => (getMcpAuthContext()?.props as Props | undefined)?.email ?? "unknown",
  });
  return server;
}
