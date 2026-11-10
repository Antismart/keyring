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

/**
 * What is being moved.
 *
 * Amounts are always in the asset's own base units, which is why limits are
 * per asset rather than merely per chain: 1 USDC (6 decimals) and 1 ETH (18)
 * are not comparable quantities. Fees are separate — always paid in the
 * chain's native coin — so the fee cap lives on the chain policy.
 */
export type Asset = "native" | { erc20: { token: string } };

/** Narrows an {@link Asset} to the ERC-20 case. */
export function isErc20(asset: Asset): asset is { erc20: { token: string } } {
  return typeof asset === "object" && "erc20" in asset;
}

/** Chains Keyring can sign for. Mirrors the Rust `Chain` enum. */
export type Chain = "base_sepolia" | "bitcoin_testnet4";

/**
 * Gas parameters for an EVM transfer.
 *
 * Supplied by the caller from an RPC. Note what is absent: no recipient, no
 * amount, no calldata. Wrong values here cause a transaction that fails or
 * overpays within the fee cap; none of them can redirect a payment.
 *
 * The fee is **not** a parameter. The contract derives it as
 * `gas_limit * max_fee_per_gas`, so the value policy checks is the same number
 * the transaction can actually spend.
 */
export interface EvmParams {
  /** Sender nonce, as a decimal string. */
  nonce: string;
  /** Gas limit. Must be between 21000 and 200000 for a plain transfer. */
  gas_limit: string;
  /** Fee ceiling per gas, in wei. */
  max_fee_per_gas: string;
  /** Tip per gas, in wei. Must not exceed `max_fee_per_gas`. */
  max_priority_fee_per_gas: string;
}

/** Chain-specific transaction parameters. */
export type ChainParams = { evm: EvmParams };

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

/**
 * Limits for one asset on one chain.
 *
 * The presence of an entry is itself the asset allowlist: an agent permitted to
 * move a token is not thereby permitted to send native value, or the reverse.
 */
export interface AssetPolicy {
  asset: Asset;
  max_per_request: BaseUnits;
  max_per_24h: BaseUnits;
  /** Allowlisted destinations. An empty array permits nobody, never anybody. */
  allowed_destinations: string[];
}

/**
 * Per-chain policy. The presence of an entry is the chain allowlist.
 *
 * `max_fee` is in the chain's native units because a fee is always paid in the
 * native coin — an ERC-20 transfer still costs ETH.
 */
export interface ChainPolicy {
  chain: Chain;
  max_fee: BaseUnits;
  assets: AssetPolicy[];
}

/** An owner-wide 24-hour ceiling for one asset on one chain. */
export interface AggregateCap {
  chain: Chain;
  asset: Asset;
  max_per_24h: BaseUnits;
}

/**
 * The keyring-wide budget.
 *
 * Agent caps bound a single agent; this bounds the sum across every agent the
 * owner has registered. Without it, an owner running N agents each capped at C
 * is exposed to N x C. Optional: an empty `caps` array means per-agent limits
 * only, which is the default.
 */
export interface AggregateBudget {
  caps: AggregateCap[];
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
  | "asset_not_allowed"
  | "malformed_destination"
  | "destination_not_allowed"
  | "outside_time_window"
  | "amount_zero"
  | "per_request_cap_exceeded"
  | "fee_cap_exceeded"
  | "daily_cap_exceeded"
  | "owner_daily_cap_exceeded"
  | "budget_ledger_full"
  | "owner_budget_ledger_full"
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

/** The rolling ledger for one asset on one chain. */
export interface AssetLedger {
  chain: Chain;
  asset: Asset;
  entries: SpendEntry[];
}

/** A registered agent. */
export interface Agent {
  public_key: PublicKeyString;
  label: string;
  enabled: boolean;
  policy: Policy;
  ledgers: AssetLedger[];
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
  /** Owner-wide 24-hour ceilings, across every agent. */
  aggregate: AggregateBudget;
  /**
   * The keyring-wide rolling ledger the owner-wide cap is checked against.
   *
   * Deliberately not cleared when an agent is revoked, so revoking and
   * re-registering cannot reset the owner-wide budget.
   */
  ledgers: AssetLedger[];
}

/** A transfer request and its audit record. */
export interface TransferRequest {
  id: number;
  owner: AccountId;
  agent_public_key: PublicKeyString;
  chain: Chain;
  /** What was moved: the native coin, or a token. */
  asset: Asset;
  destination: string;
  amount: BaseUnits;
  /**
   * The maximum fee the signed transaction can pay.
   *
   * Derived by the contract from {@link TransferRequest.params}, never
   * supplied by the caller.
   */
  fee: BaseUnits;
  /** The chain-specific inputs used to build the signed transaction. */
  params: ChainParams;
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
