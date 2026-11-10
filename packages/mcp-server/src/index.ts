/**
 * `@keyring/mcp-server` — narrowly scoped Keyring tools for an AI agent.
 *
 * ## Status
 *
 * This package currently exports the tool surface: names, JSON Schemas and
 * input validators (see `./tools.js`). The MCP transport wiring is added at
 * Gate F against a deployed testnet contract, together with the
 * `@modelcontextprotocol/sdk` dependency, so that the server is verified
 * end to end rather than written against a remembered API.
 *
 * The server must never be relied upon for enforcement (CLAUDE.md §8). It makes
 * the safe path easy; the contract makes the unsafe path impossible.
 */

export * from "./tools.js";
