/**
 * A thin, typed client for the Keyring contract.
 *
 * ## Why this file contains no NEAR networking code
 *
 * The client talks to NEAR through an injected {@link NearConnection} rather
 * than embedding a specific NEAR client library. Two reasons:
 *
 * 1. CLAUDE.md §2 forbids writing against an SDK's API from memory. The exact
 *    call surface of the NEAR JS tooling is verified and wired at Gate C, when
 *    there is a deployed contract to verify it against.
 * 2. It keeps the security property clear. The client cannot be a policy
 *    authority — it has no decision logic at all, only serialisation. Swapping
 *    the transport cannot change what is or is not allowed, because the
 *    contract decides.
 *
 * Supply a connection that wraps whichever NEAR library you already use.
 */

import type {
  AccountId,
  Agent,
  BaseUnits,
  Chain,
  Keyring,
  Policy,
  PublicKeyString,
  RequestOutcome,
  SignerBackend,
  SimulationResult,
  TransferRequest,
} from "./types.js";

/** A read-only (view) call into a NEAR contract. */
export interface NearViewCall {
  <T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T>;
}

/** A state-changing (function) call into a NEAR contract. */
export interface NearFunctionCall {
  <T>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    options?: { gas?: bigint; deposit?: bigint },
  ): Promise<T>;
}

/** The transport the client needs. Provide an adapter over your NEAR library. */
export interface NearConnection {
  view: NearViewCall;
  call: NearFunctionCall;
}

export interface KeyringClientOptions {
  /** Account id the Keyring contract is deployed to. */
  contractId: AccountId;
  connection: NearConnection;
}

/** Arguments for a transfer request. */
export interface TransferArgs {
  chain: Chain;
  /** Destination address in its chain-native form. */
  destination: string;
  /** Amount in base units (wei / satoshi) as a decimal string. */
  amount: BaseUnits;
  /** The fee the broadcast transaction will pay, in base units. */
  fee: BaseUnits;
  /**
   * A caller-chosen key that makes the request idempotent. Re-sending the same
   * key returns the original request instead of creating a second one.
   */
  idempotencyKey: string;
}

/**
 * Typed wrapper over the Keyring contract.
 *
 * Method names mirror the contract's, so an SDK call maps one-to-one onto an
 * auditable on-chain method.
 */
export class KeyringClient {
  readonly contractId: AccountId;
  private readonly near: NearConnection;

  constructor(options: KeyringClientOptions) {
    this.contractId = options.contractId;
    this.near = options.connection;
  }

  // ------------------------------------------------------------------- views

  /** Fetches an owner's Keyring, or `null` if they have not registered one. */
  async getKeyring(owner: AccountId): Promise<Keyring | null> {
    return this.near.view<Keyring | null>(this.contractId, "get_keyring", { owner });
  }

  async getAgent(owner: AccountId, publicKey: PublicKeyString): Promise<Agent | null> {
    return this.near.view<Agent | null>(this.contractId, "get_agent", {
      owner,
      public_key: publicKey,
    });
  }

  async getPolicy(owner: AccountId, publicKey: PublicKeyString): Promise<Policy | null> {
    return this.near.view<Policy | null>(this.contractId, "get_policy", {
      owner,
      public_key: publicKey,
    });
  }

  async getRequest(requestId: number): Promise<TransferRequest | null> {
    return this.near.view<TransferRequest | null>(this.contractId, "get_request", {
      request_id: requestId,
    });
  }

  /** Returns a page of an owner's request history, newest first. */
  async getHistory(
    owner: AccountId,
    options: { fromIndex?: number; limit?: number } = {},
  ): Promise<TransferRequest[]> {
    return this.near.view<TransferRequest[]>(this.contractId, "get_history", {
      owner,
      from_index: options.fromIndex ?? null,
      limit: options.limit ?? null,
    });
  }

  /**
   * Asks the contract what it *would* decide, without creating a request.
   *
   * This is a view call: it reserves no budget and records nothing. Use it to
   * show an agent or an operator why a transfer would be refused.
   */
  async simulateTransfer(
    owner: AccountId,
    agentPublicKey: PublicKeyString,
    args: Omit<TransferArgs, "idempotencyKey">,
  ): Promise<SimulationResult> {
    return this.near.view<SimulationResult>(this.contractId, "simulate_transfer", {
      owner,
      agent_public_key: agentPublicKey,
      chain: args.chain,
      destination: args.destination,
      amount: args.amount,
      fee: args.fee,
    });
  }

  /**
   * The MPC derivation path for an agent/chain pair.
   *
   * Computed by the contract from its own state. The corresponding
   * foreign-chain address is derived from this path plus the MPC root key at
   * Gate C; this SDK does not derive addresses yet, because doing so requires
   * the verified Chain Signatures derivation scheme rather than a guess.
   */
  async getDerivationPath(
    owner: AccountId,
    publicKey: PublicKeyString,
    chain: Chain,
  ): Promise<string | null> {
    return this.near.view<string | null>(this.contractId, "get_derivation_path", {
      owner,
      public_key: publicKey,
      chain,
    });
  }

  /** Which signing backend this deployment uses. */
  async getSignerBackend(): Promise<SignerBackend> {
    return this.near.view<SignerBackend>(this.contractId, "get_signer_backend", {});
  }

  /**
   * Whether this deployment signs with the mock backend.
   *
   * Check this before describing any result as a real signature.
   */
  async isMockSigner(): Promise<boolean> {
    return this.near.view<boolean>(this.contractId, "is_mock_signer", {});
  }

  // --------------------------------------------------------------- owner calls

  /** Registers the calling account as a Keyring owner. */
  async registerKeyring(): Promise<void> {
    await this.near.call<void>(this.contractId, "register_keyring", {});
  }

  /** Registers an agent public key with a policy. Owner only. */
  async registerAgent(
    publicKey: PublicKeyString,
    label: string,
    policy: Policy,
  ): Promise<void> {
    await this.near.call<void>(this.contractId, "register_agent", {
      public_key: publicKey,
      label,
      policy,
    });
  }

  /** Replaces an agent's policy. Owner only. */
  async setPolicy(publicKey: PublicKeyString, policy: Policy): Promise<void> {
    await this.near.call<void>(this.contractId, "set_policy", {
      public_key: publicKey,
      policy,
    });
  }

  /** Disables an agent — the kill switch. Owner only. */
  async disableAgent(publicKey: PublicKeyString): Promise<void> {
    await this.near.call<void>(this.contractId, "set_agent_enabled", {
      public_key: publicKey,
      enabled: false,
    });
  }

  /** Re-enables a disabled agent. Owner only. */
  async enableAgent(publicKey: PublicKeyString): Promise<void> {
    await this.near.call<void>(this.contractId, "set_agent_enabled", {
      public_key: publicKey,
      enabled: true,
    });
  }

  /** Removes an agent entirely. Owner only. */
  async revokeAgent(publicKey: PublicKeyString): Promise<void> {
    await this.near.call<void>(this.contractId, "revoke_agent", {
      public_key: publicKey,
    });
  }

  // --------------------------------------------------------------- agent calls

  /**
   * Requests a transfer. Must be called with a registered agent key.
   *
   * A policy refusal **resolves** with `{ outcome: "refused", … }`; it does not
   * throw. Always discriminate on `outcome` — treating a resolved promise as
   * success would report a refused payment as a completed one.
   */
  async requestTransfer(args: TransferArgs): Promise<RequestOutcome> {
    return this.near.call<RequestOutcome>(this.contractId, "request_transfer", {
      chain: args.chain,
      destination: args.destination,
      amount: args.amount,
      fee: args.fee,
      idempotency_key: args.idempotencyKey,
    });
  }
}
