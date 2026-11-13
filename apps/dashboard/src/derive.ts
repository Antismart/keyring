/**
 * Address derivation from the MPC signer's keys.
 *
 * The signer binds every derived key to its own caller, so `predecessor` must
 * be the Keyring contract. Asking with any other caller returns a different
 * key that controls nothing in Keyring.
 */

import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { base58, bech32 } from "@scure/base";

import { ECDSA_DOMAIN_ID, MPC_SIGNER } from "./config";
import { view } from "./rpc";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function rawKey(nearPublicKey: string): Uint8Array {
  const parts = nearPublicKey.split(":");
  if (parts.length !== 2 || parts[0] !== "secp256k1") {
    throw new Error(`expected a secp256k1 key, got ${nearPublicKey}`);
  }
  const raw = base58.decode(parts[1]!);
  if (raw.length !== 64) throw new Error(`expected 64 key bytes, got ${raw.length}`);
  return raw;
}

/**
 * An Ethereum address is the last 20 bytes of keccak-256 over the 64 raw key
 * bytes. The SEC1 `0x04` uncompressed prefix is deliberately not hashed.
 */
export function evmAddress(nearPublicKey: string): string {
  return `0x${hex(keccak_256(rawKey(nearPublicKey)).slice(12))}`;
}

/** Bitcoin's compressed form: `0x02`/`0x03` by the parity of y, then x. */
export function compressedKey(nearPublicKey: string): Uint8Array {
  const raw = rawKey(nearPublicKey);
  const out = new Uint8Array(33);
  out[0] = (raw[63]! & 1) === 0 ? 0x02 : 0x03;
  out.set(raw.subarray(0, 32), 1);
  return out;
}

/** The native-segwit (P2WPKH) address for a derived key, on testnet. */
export function btcAddress(nearPublicKey: string): string {
  const program = ripemd160(sha256(compressedKey(nearPublicKey)));
  return bech32.encode("tb", [0, ...bech32.toWords(program)]);
}

export interface DerivedAddress {
  publicKey: string;
  address: string;
  /** Present for Bitcoin: the value the owner must register with the contract. */
  compressed: string | null;
}

/**
 * Cache of resolved keys.
 *
 * A derived key is a pure function of (signer root key, predecessor, path), so
 * it never changes for a given path and is safe to remember. The signer takes
 * seconds to answer, which is long enough to look broken, so the answer is
 * kept in memory for the session and in `localStorage` across reloads.
 *
 * Only public keys are stored. Storage can be blocked or cleared, so every
 * access is guarded and a miss simply costs the round trip.
 */
const memo = new Map<string, string>();
const STORAGE_PREFIX = "keyring:derived:";

function cached(key: string): string | null {
  const hit = memo.get(key);
  if (hit) return hit;
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + key);
    if (stored) memo.set(key, stored);
    return stored;
  } catch {
    return null;
  }
}

function remember(key: string, publicKey: string): void {
  memo.set(key, publicKey);
  try {
    localStorage.setItem(STORAGE_PREFIX + key, publicKey);
  } catch {
    // A full or blocked store only costs us the round trip next time.
  }
}

export async function derivedAddress(
  contractId: string,
  path: string,
  chain: string,
): Promise<DerivedAddress> {
  const cacheKey = `${contractId}|${path}`;
  let publicKey = cached(cacheKey);
  if (!publicKey) {
    publicKey = await view<string>(MPC_SIGNER, "derived_public_key", {
      path,
      predecessor: contractId,
      domain_id: ECDSA_DOMAIN_ID,
    });
    remember(cacheKey, publicKey);
  }
  const isBtc = chain === "bitcoin_testnet4";
  return {
    publicKey,
    address: isBtc ? btcAddress(publicKey) : evmAddress(publicKey),
    compressed: isBtc ? hex(compressedKey(publicKey)) : null,
  };
}
