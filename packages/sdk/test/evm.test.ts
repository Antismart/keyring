/**
 * Tests for assembling the broadcastable transaction.
 *
 * These read the same viem-generated fixture the Rust tests use, so the
 * contract and the SDK are checked against one shared reference rather than
 * against each other.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildSignedTransaction,
  signingHash,
  toViemSignature,
  verifySignedTransaction,
  type TransferRequest,
} from "../dist/index.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../../contracts/keyring/tests/fixtures/eip1559.json", import.meta.url),
    "utf8",
  ),
);
const F = fixtures.fixtures[0]; // typical_transfer

/** A request shaped exactly as the contract would record it. */
function request(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    id: 1,
    owner: "owner.testnet",
    agent_public_key: "ed25519:abc",
    chain: "base_sepolia",
    destination: F.to,
    amount: F.value,
    fee: (BigInt(F.gas_limit) * BigInt(F.max_fee_per_gas)).toString(),
    params: {
      evm: {
        nonce: String(F.nonce),
        gas_limit: F.gas_limit,
        max_fee_per_gas: F.max_fee_per_gas,
        max_priority_fee_per_gas: F.max_priority_fee_per_gas,
      },
    },
    status: "signed",
    reserved: F.value,
    idempotency_key: "k1",
    created_at_ms: 0,
    updated_at_ms: 0,
    refusal: null,
    signature: {
      scheme: "Secp256k1",
      // A compressed point: parity prefix plus the x-coordinate, which is r.
      big_r: "02" + F.signature.r.slice(2),
      s: F.signature.s.slice(2),
      recovery_id: F.signature.yParity,
      mock: false,
    },
    failure_reason: null,
    payload_hex: F.signing_hash.slice(2),
    ...overrides,
  } as TransferRequest;
}

test("the SDK recomputes the same signing hash as the contract", () => {
  assert.equal(signingHash(request()), F.signing_hash);
});

test("the assembled transaction matches the viem reference exactly", () => {
  assert.equal(buildSignedTransaction(request()), F.signed_rlp);
});

test("r is taken from big_r without its parity prefix", () => {
  const sig = toViemSignature(request().signature!);
  assert.equal(sig.r, F.signature.r);
  assert.equal(sig.s, F.signature.s);
  assert.equal(sig.yParity, F.signature.yParity);
});

test("a mock signature is never broadcastable", () => {
  const req = request();
  req.signature!.mock = true;
  assert.throws(() => buildSignedTransaction(req), /mock signature/);
});

test("an unsigned request cannot be broadcast", () => {
  assert.throws(
    () => buildSignedTransaction(request({ status: "refused", signature: null })),
    /has no signature/,
  );
});

test("a payload that disagrees with the contract's record is refused", () => {
  // If the recorded hash and the recomputed one differ, the bytes about to be
  // broadcast are not the bytes that were signed. Refuse rather than send.
  const req = request({ payload_hex: "00".repeat(32) });
  assert.throws(() => buildSignedTransaction(req), /does not match the contract's record/);
});

test("tampering with the amount after signing is caught", () => {
  const req = request();
  const raw = buildSignedTransaction(req);
  // Same signature, but the caller now claims a different approved value.
  const tampered = request({ amount: (BigInt(F.value) + 1n).toString() });
  assert.throws(() => verifySignedTransaction(tampered, raw), /value:/);
});

test("tampering with the recipient after signing is caught", () => {
  const req = request();
  const raw = buildSignedTransaction(req);
  const tampered = request({ destination: "0x9999999999999999999999999999999999999999" });
  assert.throws(() => verifySignedTransaction(tampered, raw), /to:/);
});

test("an untampered transaction verifies against its request", () => {
  const req = request();
  verifySignedTransaction(req, buildSignedTransaction(req));
});
