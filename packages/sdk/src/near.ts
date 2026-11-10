/**
 * Concrete {@link NearConnection} adapters.
 *
 * The client takes an injected connection so that the transport is replaceable
 * and holds no authority. These are the two implementations Keyring ships.
 *
 * Reads use plain JSON-RPC over `fetch`: a view call is a single POST, so a
 * dependency buys nothing and a smaller surface is worth more in a
 * security-sensitive package. Writes need transaction signing, nonce handling
 * and block hashes, so those go through `near-api-js`.
 *
 * Neither adapter can widen what an agent may do. The key an adapter holds is
 * what bounds it: an agent's key is scoped to the Keyring contract, and the
 * contract decides every request regardless of how it arrived.
 */

import { Account } from "near-api-js";

/**
 * A NEAR private key, in the curve-prefixed form the key files use.
 *
 * Typed as a literal union rather than `string` so a key missing its curve
 * prefix is a compile error instead of a runtime failure.
 */
export type NearPrivateKey = `ed25519:${string}` | `secp256k1:${string}`;

import type { NearConnection } from "./client.js";

/** Public RPC endpoints, for convenience. */
export const NEAR_RPC = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
} as const;

/** A view call over JSON-RPC. */
export async function viewFunction<T>(
  rpcUrl: string,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "keyring",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = (await res.json()) as {
    result?: { result: number[]; error?: string };
    error?: unknown;
  };
  if (body.error) {
    throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  }
  if (body.result?.error) {
    throw new Error(`${method}: ${body.result.error}`);
  }
  const raw = Buffer.from(body.result!.result).toString();
  return (raw.length === 0 ? null : JSON.parse(raw)) as T;
}

/**
 * A read-only connection.
 *
 * Any state-changing call throws rather than failing somewhere less obvious.
 * Use this wherever only reads should be possible — a dashboard, a monitor, or
 * an MCP server exposing nothing but views.
 */
export function createViewConnection(rpcUrl: string = NEAR_RPC.testnet): NearConnection {
  return {
    view: (contractId, method, args) => viewFunction(rpcUrl, contractId, method, args),
    call: () => {
      throw new Error("this connection is read-only; no state-changing call is possible");
    },
  };
}

export interface SigningConnectionOptions {
  /** Account whose key signs. For an agent this is the agent's own account. */
  accountId: string;
  /** Private key, e.g. `ed25519:<base58>`. */
  privateKey: NearPrivateKey;
  rpcUrl?: string;
  /** Default gas for a call, in gas units. */
  defaultGas?: bigint;
}

/**
 * A connection that can sign transactions.
 *
 * Default gas is 300 TGas because `request_transfer` forwards 100 TGas to the
 * MPC signer and reserves 20 for its callback; a smaller budget makes signing
 * fail partway rather than cleanly.
 */
export function createSigningConnection(options: SigningConnectionOptions): NearConnection {
  const rpcUrl = options.rpcUrl ?? NEAR_RPC.testnet;
  const defaultGas = options.defaultGas ?? 300_000_000_000_000n;
  const account = new Account(options.accountId, rpcUrl, options.privateKey);

  return {
    view: (contractId, method, args) => viewFunction(rpcUrl, contractId, method, args),
    call: async <T>(
      contractId: string,
      method: string,
      args: Record<string, unknown>,
      callOptions?: { gas?: bigint; deposit?: bigint },
    ): Promise<T> => {
      const result = await account.callFunction({
        contractId,
        methodName: method,
        args,
        gas: callOptions?.gas ?? defaultGas,
        deposit: callOptions?.deposit ?? 0n,
      });
      return result as T;
    },
  };
}

/** The MPC signer contract per network. */
export const MPC_SIGNER = {
  testnet: "v1.signer-prod.testnet",
  mainnet: "v1.signer",
} as const;

/** The secp256k1 signing domain on the deployed signer. */
export const ECDSA_DOMAIN_ID = 0;

/**
 * Asks the MPC signer for the key it derives for a path, and returns the
 * matching EVM address.
 *
 * The signer binds every derived key to its own caller, so `predecessor` must
 * be the Keyring contract. Passing anything else yields a different key that
 * controls nothing in Keyring.
 */
export async function deriveEvmAddress(options: {
  path: string;
  /** The Keyring contract account. */
  predecessor: string;
  rpcUrl?: string;
  signerContractId?: string;
}): Promise<{ publicKey: string; address: string }> {
  const rpcUrl = options.rpcUrl ?? NEAR_RPC.testnet;
  const signer = options.signerContractId ?? MPC_SIGNER.testnet;
  const publicKey = await viewFunction<string>(rpcUrl, signer, "derived_public_key", {
    path: options.path,
    predecessor: options.predecessor,
    domain_id: ECDSA_DOMAIN_ID,
  });
  const { evmAddressFromNearKey } = await import("./evm.js");
  return { publicKey, address: evmAddressFromNearKey(publicKey) };
}
