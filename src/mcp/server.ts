import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Env, Props } from "../env";
import { GscClient } from "../gsc/client";
import { registerTools } from "./tools";

export class GscMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "mcp-gsc", version: "0.1.0" });

  async init(): Promise<void> {
    let client: GscClient | undefined;
    registerTools(this.server, {
      client: () => (client ??= new GscClient(this.env.GSC_SERVICE_ACCOUNT_JSON)),
      user: () => this.props?.email ?? "unknown",
    });
  }
}
