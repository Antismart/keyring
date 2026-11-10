/**
 * Assembling and broadcasting the signed EVM transaction.
 *
 * # Where authority lives
 *
 * This module has none. The contract decided what may be sent and signed the
 * exact bytes; all that remains is to attach the signature and hand the result
 * to an RPC. If this code is wrong the transaction fails to broadcast or is
 * rejected by the network — it cannot change the recipient or the amount,
 * because those are already inside the signed payload.
 *
 * {@link verifySignedTransaction} makes that checkable rather than assumed: it
 * re-derives the transaction from the contract's own record and confirms the
 * assembled bytes carry the recipient and value the contract approved.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { base58 } from "@scure/base";
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseTransaction,
  serializeTransaction,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";

import { isErc20, type EvmParams, type StoredSignature, type TransferRequest } from "./types.js";

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** Chain ids for the EVM chains Keyring supports. */
export const CHAIN_IDS = { base_sepolia: 84532 } as const;

function requireEvmParams(request: TransferRequest): EvmParams {
  if (!("evm" in request.params)) {
    throw new Error(`request ${request.id} does not carry EVM parameters`);
  }
  return request.params.evm;
}

/** Rebuilds the unsigned transaction exactly as the contract built it. */
export function toSerializable(request: TransferRequest): TransactionSerializableEIP1559 {
  const p = requireEvmParams(request);
  const chainId = CHAIN_IDS[request.chain as keyof typeof CHAIN_IDS];
  if (chainId === undefined) {
    throw new Error(`no EVM chain id known for ${request.chain}`);
  }
  const base = {
    type: "eip1559" as const,
    chainId,
    nonce: Number(p.nonce),
    gas: BigInt(p.gas_limit),
    maxFeePerGas: BigInt(p.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(p.max_priority_fee_per_gas),
  };

  // A token transfer is a call to the token contract: the recipient lives in
  // the calldata, `to` is the token, and no native value is sent. This mirrors
  // what the contract built; the hash check below proves they agree.
  if (isErc20(request.asset)) {
    return {
      ...base,
      to: request.asset.erc20.token as Hex,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [request.destination as Hex, BigInt(request.amount)],
      }),
    };
  }

  return {
    ...base,
    to: request.destination as Hex,
    value: BigInt(request.amount),
  };
}

/**
 * The hash the MPC signer was asked to sign.
 *
 * Recomputed here from the request's own fields, so it can be compared against
 * the `payload_hex` the contract recorded. A mismatch means the transaction
 * being broadcast is not the one that was signed, and it must not be sent.
 */
export function signingHash(request: TransferRequest): Hex {
  return keccak256(serializeTransaction(toSerializable(request)));
}

/**
 * Converts the contract's stored signature into viem's representation.
 *
 * `big_r` is a compressed curve point: its first byte is the parity prefix and
 * the remaining 32 bytes are the x-coordinate, which is the signature's `r`.
 */
export function toViemSignature(signature: StoredSignature): {
  r: Hex;
  s: Hex;
  yParity: number;
} {
  const bigR = signature.big_r.startsWith("0x") ? signature.big_r.slice(2) : signature.big_r;
  if (bigR.length !== 66) {
    throw new Error(`big_r must be a 33-byte compressed point, got ${bigR.length / 2} bytes`);
  }
  const s = signature.s.startsWith("0x") ? signature.s.slice(2) : signature.s;
  return {
    r: `0x${bigR.slice(2)}` as Hex,
    s: `0x${s}` as Hex,
    yParity: signature.recovery_id,
  };
}

/**
 * Builds the raw transaction to broadcast.
 *
 * Refuses to produce bytes unless the request actually holds a real signature
 * and the recomputed signing hash matches the one the contract recorded.
 */
export function buildSignedTransaction(request: TransferRequest): Hex {
  if (request.status !== "signed" || !request.signature) {
    throw new Error(`request ${request.id} has no signature (status: ${request.status})`);
  }
  if (request.signature.mock) {
    throw new Error(
      `request ${request.id} carries a mock signature and must never be broadcast`,
    );
  }
  const expected = signingHash(request);
  if (request.payload_hex && `0x${request.payload_hex}` !== expected) {
    throw new Error(
      `refusing to broadcast: recomputed signing hash ${expected} does not match the ` +
        `contract's record 0x${request.payload_hex}`,
    );
  }
  return serializeTransaction(toSerializable(request), toViemSignature(request.signature));
}

/**
 * Confirms assembled bytes still carry the approved recipient and value.
 *
 * Parses the serialized transaction back and compares against the contract's
 * record, so a broadcast cannot silently send different terms than were
 * authorised.
 */
export function verifySignedTransaction(request: TransferRequest, raw: Hex): void {
  const parsed = parseTransaction(raw);
  const expected = toSerializable(request);
  const mismatches: string[] = [];
  // For a token transfer the recipient and amount live in the calldata, so
  // comparing `to` and `value` alone would not catch a redirected payment.
  if (isErc20(request.asset)) {
    const expectedData = (expected as { data?: Hex }).data;
    if (parsed.data !== expectedData) {
      mismatches.push(`calldata: ${parsed.data} != ${expectedData}`);
    }
  }
  if (parsed.to?.toLowerCase() !== expected.to?.toLowerCase()) {
    mismatches.push(`to: ${parsed.to} != ${expected.to}`);
  }
  // viem omits `value` entirely when it is zero, which is exactly the token
  // transfer case, so an undefined here means zero rather than a mismatch.
  if ((parsed.value ?? 0n) !== (expected.value ?? 0n)) {
    mismatches.push(`value: ${parsed.value ?? 0n} != ${expected.value ?? 0n}`);
  }
  if (parsed.chainId !== expected.chainId) {
    mismatches.push(`chainId: ${parsed.chainId} != ${expected.chainId}`);
  }
  if (BigInt(parsed.nonce ?? -1) !== BigInt(expected.nonce ?? -1)) {
    mismatches.push(`nonce: ${parsed.nonce} != ${expected.nonce}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`signed transaction does not match the approved request: ${mismatches.join("; ")}`);
  }
}

/** Minimal JSON-RPC call against an EVM node. */
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Fetches the gas parameters needed to build a request. */
export async function fetchEvmParams(
  rpcUrl: string,
  from: string,
  options: { gasLimit?: bigint } = {},
): Promise<EvmParams> {
  const [nonceHex, feeHex] = await Promise.all([
    rpc<Hex>(rpcUrl, "eth_getTransactionCount", [from, "latest"]),
    rpc<Hex>(rpcUrl, "eth_gasPrice", []),
  ]);
  const gasPrice = BigInt(feeHex);
  // Headroom over the observed price so the transaction stays includable if
  // the base fee rises before broadcast. The fee cap still bounds the cost.
  const maxFeePerGas = gasPrice * 2n + 1n;
  return {
    nonce: BigInt(nonceHex).toString(),
    gas_limit: (options.gasLimit ?? 21000n).toString(),
    max_fee_per_gas: maxFeePerGas.toString(),
    max_priority_fee_per_gas: (gasPrice / 2n).toString(),
  };
}

/** Broadcasts a raw transaction and returns its hash. */
export async function broadcast(rpcUrl: string, raw: Hex): Promise<Hex> {
  return rpc<Hex>(rpcUrl, "eth_sendRawTransaction", [raw]);
}

/** Waits for a receipt, polling until `timeoutMs` elapses. */
export async function waitForReceipt(
  rpcUrl: string,
  txHash: Hex,
  timeoutMs = 120_000,
): Promise<{ status: Hex; blockNumber: Hex; gasUsed: Hex }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc<{ status: Hex; blockNumber: Hex; gasUsed: Hex } | null>(
      rpcUrl,
      "eth_getTransactionReceipt",
      [txHash],
    );
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`no receipt for ${txHash} within ${timeoutMs}ms`);
}

/**
 * The EVM address for a NEAR-format secp256k1 public key.
 *
 * NEAR encodes such a key as 64 raw bytes (`x || y`). An Ethereum address is
 * the last 20 bytes of the keccak-256 hash of exactly those 64 bytes — note
 * that the SEC1 `0x04` uncompressed prefix is *not* hashed.
 */
export function evmAddressFromNearKey(nearPublicKey: string): Hex {
  const parts = nearPublicKey.split(":");
  if (parts.length !== 2 || parts[0] !== "secp256k1") {
    throw new Error(`expected a secp256k1 NEAR key, got ${nearPublicKey}`);
  }
  const raw = base58.decode(parts[1]!);
  if (raw.length !== 64) {
    throw new Error(`expected a 64-byte key, got ${raw.length} bytes`);
  }
  const hash = keccak_256(raw);
  return `0x${Buffer.from(hash.slice(12)).toString("hex")}` as Hex;
}
