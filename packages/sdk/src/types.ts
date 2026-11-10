/**
 * Types mirroring the Keyring contract's public interface.
 *
 * Every type here corresponds to a Rust type in `contracts/keyring/src`. The
 * contract is authoritative: these definitions exist so callers get type safety
 * and autocompletion, never so the SDK can make a policy decision of its own.
 *
 * ## Money
 *
 * All amounts are integer strings in the smallest base unit of their chain —
 * wei for Base Sepolia, satoshi for Bitcoin testnet4. They are strings because
 * a u128 does not fit in a JavaScript `number`, and because the contract
 * serialises `U128` as a JSON string. Never parse these with `Number()`; use
 * `BigInt()` if you need arithmetic.
 */

/** An integer amount in base units, as a decimal string. */
export type BaseUnits = string;

/** Chains Keyring can sign for. Mirrors the Rust `Chain` enum. */
export type Chain = "base_sepolia" | "bitcoin_testnet4";

/** A NEAR public key in `ed25519:<base58>` or `secp256k1:<base58>` form. */
export type PublicKeyString = string;

/** A NEAR account id. */
export type AccountId = string;

/**
 * A UTC time-of-day window, in minutes from midnight, half-open
 * `[startMinute, endMinute)`. When `startMinute > endMinute` the window wraps
 * midnight.
 */
export interface TimeWindow {
  start_minute: number;
  end_minute: number;
}

/** Per-chain limits. The presence of an entry is itself the chain allowlist. */
export interface ChainPolicy {
  chain: Chain;
  max_per_request: BaseUnits;
  max_per_24h: BaseUnits;
  max_fee: BaseUnits;
  /** Allowlisted destinations. An empty array permits nobody, never anybody. */
  allowed_destinations: string[];
}

/** A complete agent policy. */
export interface Policy {
  chains: ChainPolicy[];
  time_window: TimeWindow | null;
}

/**
 * Stable machine-readable refusal codes.
 *
 * These are a committed part of the API surface: branch on them rather than on
 * the human-readable message, which may be reworded.
 */
export type RefusalCode =
  | "agent_not_registered"
  | "agent_disabled"
  | "chain_not_allowed"
  | "malformed_destination"
  | "destination_not_allowed"
  | "outside_time_window"
  | "amount_zero"
  | "per_request_cap_exceeded"
  | "fee_cap_exceeded"
  | "daily_cap_exceeded"
  | "budget_ledger_full"
  | "duplicate_request";

/** A structured policy refusal. */
export interface Refusal {
  code: RefusalCode;
  /** The rule family this refusal came from, e.g. `rolling_24h_cap`. */
  rule: string;
  message: string;
  /** The configured limit, for rules that have a numeric limit. */
  limit: BaseUnits | null;
  /** The value observed, for rules that have a numeric limit. */
  observed: BaseUnits | null;
}

/**
 * A signature recorded against a request.
 *
 * `mock` is stored data, not a deployment flag, so a mock signature can never
 * be mistaken for a real one by anything reading a request. Check it before
 * describing a result as a real signature.
 */
export interface StoredSignature {
  /** Always `Secp256k1` for the chains Keyring supports. */
  scheme: string;
  /** Hex-encoded curve point. */
  big_r: string;
  /** Hex-encoded scalar. */
  s: string;
  recovery_id: number;
  /** True when produced by the mock backend. Never a valid signature. */
  mock: boolean;
}

/**
 * Lifecycle state of a transfer request.
 *
 * `refused`, `signed` and `failed` are terminal.
 *
 * `created` is transient: the contract writes it and then moves the request on
 * within the same call, so a request read back from the chain is never
 * `created`. Handle it defensively, but do not build a flow that waits for it.
 */
export type RequestStatus = "created" | "refused" | "signing" | "signed" | "failed";

/** One recorded reservation against the rolling budget. */
export interface SpendEntry {
  at_ms: number;
  amount: BaseUnits;
  request_id: number;
}

export interface ChainLedger {
  chain: Chain;
  entries: SpendEntry[];
}

/** A registered agent. */
export interface Agent {
  public_key: PublicKeyString;
  label: string;
  enabled: boolean;
  policy: Policy;
  ledgers: ChainLedger[];
  created_at_ms: number;
  requests_made: number;
  recent_keys: { key: string; request_id: number }[];
}

/** An owner's Keyring. */
export interface Keyring {
  owner: AccountId;
  created_at_ms: number;
  agents: Agent[];
  history: number[];
}

/** A transfer request and its audit record. */
export interface TransferRequest {
  id: number;
  owner: AccountId;
  agent_public_key: PublicKeyString;
  chain: Chain;
  destination: string;
  amount: BaseUnits;
  fee: BaseUnits;
  status: RequestStatus;
  reserved: BaseUnits;
  idempotency_key: string;
  created_at_ms: number;
  updated_at_ms: number;
  refusal: Refusal | null;
  /**
   * Present when `status` is `signed`.
   *
   * A signature does not mean the destination-chain transaction was broadcast
   * or confirmed, and the budget reservation is never released on it.
   */
  signature: StoredSignature | null;
  /** Present when `status` is `failed`. */
  failure_reason: string | null;
  /**
   * The exact payload sent to the MPC signer, hex-encoded.
   *
   * Recorded so the signed value can be independently recomputed from the
   * fields policy approved.
   */
  payload_hex: string | null;
}

/**
 * The result of `request_transfer`.
 *
 * A refusal arrives here as a normal successful response, not a thrown error.
 * Callers must discriminate on `outcome`; treating any resolved promise as
 * success would misreport a refused payment as a completed one.
 */
export type RequestOutcome =
  /**
   * Passed policy, signing not yet attempted.
   *
   * Not currently returned: both signer backends attempt signing within the
   * same call, so a permitted request resolves to `signed` or `signing_failed`.
   * Reserved for a future deferred-signing mode.
   */
  | { outcome: "created"; request_id: number; reserved: BaseUnits }
  | { outcome: "refused"; request_id: number; refusal: Refusal }
  | { outcome: "duplicate"; request_id: number }
  | { outcome: "signed"; request_id: number }
  | { outcome: "signing_failed"; request_id: number; reason: string };

/** The result of the `simulate_transfer` view. */
export interface SimulationResult {
  allowed: boolean;
  refusal: Refusal | null;
  would_reserve: BaseUnits | null;
  spent_24h: BaseUnits;
  cap_24h: BaseUnits | null;
}

/** Which signing backend a deployment uses. */
export type SignerBackend = { mpc: { contract_id: AccountId } } | "mock";

/**
 * Whether an outcome means the request passed policy.
 *
 * Both `created` and `signed` indicate the policy allowed it, though only
 * `signed` occurs today. Neither means the payment reached a destination
 * chain: the contract does not yet construct foreign-chain transactions, and
 * even once it does, a signature is not a broadcast.
 */
export function isPermitted(o: RequestOutcome): boolean {
  return o.outcome === "created" || o.outcome === "signed";
}

/** Narrows a {@link RequestOutcome} to the signed case. */
export function isSigned(
  o: RequestOutcome,
): o is { outcome: "signed"; request_id: number } {
  return o.outcome === "signed";
}

/**
 * Narrows a {@link RequestOutcome} to the created case.
 *
 * See {@link RequestOutcome} — this case does not currently occur.
 */
export function isCreated(
  o: RequestOutcome,
): o is { outcome: "created"; request_id: number; reserved: BaseUnits } {
  return o.outcome === "created";
}

/** Narrows a {@link RequestOutcome} to the refused case. */
export function isRefused(
  o: RequestOutcome,
): o is { outcome: "refused"; request_id: number; refusal: Refusal } {
  return o.outcome === "refused";
}
