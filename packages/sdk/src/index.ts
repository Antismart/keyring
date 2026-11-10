/**
 * `@keyring/sdk` — typed client for the Keyring contract.
 *
 * The contract is the enforcement boundary. This package is a convenience
 * layer: it serialises calls and types responses, and holds no policy logic.
 * Anything it could do wrong results in a failed or rejected call, never in a
 * larger authorised spend or a different recipient.
 */

export * from "./types.js";
export * from "./client.js";
export * from "./evm.js";
export * from "./near.js";
