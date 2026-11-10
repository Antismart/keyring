#!/usr/bin/env node
/** Entry point for the Keyring MCP server. */
import { main } from "./server.js";

main().catch((err: unknown) => {
  // stderr, so a crash cannot corrupt the stdio JSON-RPC stream.
  console.error(`keyring-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
