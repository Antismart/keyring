/**
 * Bitcoin helpers: key compression and address derivation.
 *
 * The contract builds the change output itself, but it needs the Keyring's
 * compressed Bitcoin public key to do so, and it cannot ask the MPC network
 * for that synchronously. The owner registers it instead.
 *
 * That registration is a footgun if done by hand: a wrong key sends change to
 * an address the Keyring does not control. So the key is derived here from the
 * signer's own answer rather than transcribed.
 */

import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { base58, bech32 } from "@scure/base";

/** Human-readable part for Bitcoin testnet and testnet4. */
export const TESTNET_HRP = "tb";

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * Compresses a NEAR-format secp256k1 key into the 33-byte form Bitcoin uses.
 *
 * NEAR stores the key as 64 raw bytes (`x || y`). Bitcoin wants `0x02` or
 * `0x03` — chosen by the parity of `y` — followed by `x`.
 */
export function compressNearSecp256k1(nearPublicKey: string): string {
  const parts = nearPublicKey.split(":");
  if (parts.length !== 2 || parts[0] !== "secp256k1") {
    throw new Error(`expected a secp256k1 NEAR key, got ${nearPublicKey}`);
  }
  const raw = base58.decode(parts[1]!);
  if (raw.length !== 64) {
    throw new Error(`expected a 64-byte key, got ${raw.length} bytes`);
  }
  const x = raw.subarray(0, 32);
  const y = raw.subarray(32);
  // The last byte of y carries its parity.
  const prefix = (y[31]! & 1) === 0 ? 0x02 : 0x03;
  const out = new Uint8Array(33);
  out[0] = prefix;
  out.set(x, 1);
  return toHex(out);
}

/** `hash160(x) = ripemd160(sha256(x))`, as Bitcoin defines it. */
export function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

/** The native-segwit (P2WPKH) address for a compressed public key. */
export function p2wpkhAddress(compressedHex: string, hrp: string = TESTNET_HRP): string {
  const key = Uint8Array.from(Buffer.from(compressedHex, "hex"));
  if (key.length !== 33 || (key[0] !== 0x02 && key[0] !== 0x03)) {
    throw new Error("expected a 33-byte compressed secp256k1 public key");
  }
  const program = hash160(key);
  // Witness version 0, then the 20-byte program regrouped into 5-bit words.
  return bech32.encode(hrp, [0, ...bech32.toWords(program)]);
}

/**
 * Everything the owner needs to enable Bitcoin for an agent.
 *
 * Pass `compressedPubkey` to `setAgentBtcPubkey`, and fund `address`.
 */
export interface BitcoinKeyInfo {
  /** The NEAR-format derived key, as the MPC signer returns it. */
  derivedPublicKey: string;
  /** The 33-byte compressed form the contract stores. */
  compressedPubkey: string;
  /** The testnet address the Keyring spends from and receives change at. */
  address: string;
}

/** Derives the Bitcoin key material for an agent from the MPC signer. */
export async function deriveBitcoinKey(options: {
  path: string;
  /** The Keyring contract account: the signer binds keys to its caller. */
  predecessor: string;
  rpcUrl?: string;
  signerContractId?: string;
  hrp?: string;
}): Promise<BitcoinKeyInfo> {
  const { viewFunction, NEAR_RPC, MPC_SIGNER, ECDSA_DOMAIN_ID } = await import("./near.js");
  const derivedPublicKey = await viewFunction<string>(
    options.rpcUrl ?? NEAR_RPC.testnet,
    options.signerContractId ?? MPC_SIGNER.testnet,
    "derived_public_key",
    { path: options.path, predecessor: options.predecessor, domain_id: ECDSA_DOMAIN_ID },
  );
  const compressedPubkey = compressNearSecp256k1(derivedPublicKey);
  return {
    derivedPublicKey,
    compressedPubkey,
    address: p2wpkhAddress(compressedPubkey, options.hrp ?? TESTNET_HRP),
  };
}
