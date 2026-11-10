/**
 * Bitcoin key and address derivation, checked against the bitcoinjs-lib
 * fixtures the contract tests use. One shared reference, not two
 * implementations agreeing with each other.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { compressNearSecp256k1, hash160, p2wpkhAddress } from "../dist/index.js";

const fx = JSON.parse(
  readFileSync(
    new URL("../../../contracts/keyring/tests/fixtures/bitcoin.json", import.meta.url),
    "utf8",
  ),
);
const S = fx.spends[0];

test("the address derived from the fixture key matches bitcoinjs-lib", () => {
  assert.equal(p2wpkhAddress(S.keyring_pubkey), S.keyring_address);
});

test("hash160 matches bitcoinjs-lib", () => {
  const h = Buffer.from(hash160(Uint8Array.from(Buffer.from(S.keyring_pubkey, "hex")))).toString(
    "hex",
  );
  assert.equal(h, S.keyring_hash160);
});

test("an uncompressed or malformed key is rejected", () => {
  assert.throws(() => p2wpkhAddress("04" + "11".repeat(64)), /33-byte compressed/);
  assert.throws(() => p2wpkhAddress("02" + "11".repeat(10)), /33-byte compressed/);
});

test("compression picks the prefix from the parity of y", async () => {
  // Build a NEAR-format key whose y is even, then one whose y is odd, and
  // check the prefix flips. Getting this wrong would derive a valid-looking
  // address for a key the Keyring does not control.
  const { base58 } = await import("@scure/base");
  const even = new Uint8Array(64);
  even[31] = 1; // x
  even[63] = 0x02; // y ends even
  const odd = new Uint8Array(64);
  odd[31] = 1;
  odd[63] = 0x03; // y ends odd
  assert.ok(compressNearSecp256k1(`secp256k1:${base58.encode(even)}`).startsWith("02"));
  assert.ok(compressNearSecp256k1(`secp256k1:${base58.encode(odd)}`).startsWith("03"));
});

test("a non-secp256k1 key is rejected", () => {
  assert.throws(() => compressNearSecp256k1("ed25519:abc"), /expected a secp256k1/);
});
