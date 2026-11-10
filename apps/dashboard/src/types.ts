/**
 * Contract shapes, re-exported as types only.
 *
 * `import type` is erased at build time, so the SDK — and `near-api-js` with
 * it — never enters the browser bundle. Reads here go through plain JSON-RPC
 * and writes through the wallet, so the runtime dependency is unnecessary.
 */

export type {
  Agent,
  AggregateBudget,
  Asset,
  AssetLedger,
  AssetPolicy,
  ChainPolicy,
  Keyring,
  Policy,
  Refusal,
  RequestStatus,
  SpendEntry,
  TransferRequest,
} from "@keyring/sdk";

export type SignerBackend = { mpc: { contract_id: string } } | "mock";
