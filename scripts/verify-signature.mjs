#!/usr/bin/env node
/**
 * Independently verify a Keyring signature produced by NEAR Chain Signatures.
 *
 * Gate C requires that a signature be verified independently of the contract
 * that requested it. This script shares no code with the contract: it refetches
 * everything from the chain, recomputes the signed payload from the
 * policy-approved fields, asks the MPC signer for the derived public key, and
 * checks the ECDSA signature against both.
 *
 * Usage:
 *   node scripts/verify-signature.mjs <keyring-account> <request-id> [network]
 *
 * Exits non-zero if any check fails.
 */

import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { base58 } from "@scure/base";

const [account, requestIdArg, network = "testnet"] = process.argv.slice(2);
if (!account || !requestIdArg) {
  console.error("usage: verify-signature.mjs <keyring-account> <request-id> [network]");
  process.exit(2);
}
const requestId = Number(requestIdArg);
const RPC = `https://rpc.${network}.near.org`;
const SIGNER = network === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet";

/** Calls a read-only contract method over JSON-RPC. */
async function view(contractId, method, args) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
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
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  if (body.result?.error) throw new Error(`${method}: ${body.result.error}`);
  return JSON.parse(Buffer.from(body.result.result).toString());
}

const hex = (buf) => Buffer.from(buf).toString("hex");
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`\nVerifying ${account} request #${requestId} on ${network}\n`);

const request = await view(account, "get_request", { request_id: requestId });
if (!request) throw new Error(`request ${requestId} not found`);

console.log("Request");
console.log(`  chain       ${request.chain}`);
console.log(`  destination ${request.destination}`);
console.log(`  amount      ${request.amount}`);
console.log(`  fee         ${request.fee}`);
console.log(`  status      ${request.status}\n`);

console.log("Checks");

check("request reached the signed state", request.status === "signed", request.status);
check("a signature is recorded", Boolean(request.signature));
check(
  "the signature is not a mock",
  request.signature?.mock === false,
  request.signature?.mock ? "MOCK SIGNATURE — not real MPC output" : "real signer output",
);

// 1. Recompute the signed payload from the approved fields alone.
//    This must mirror `signer::gate_c_commitment` in the contract.
const chainId = { base_sepolia: "base-sepolia", bitcoin_testnet4: "bitcoin-testnet4" }[
  request.chain
];
const preimage = [
  "keyring-v1:gate-c-commitment",
  account,
  String(requestId),
  chainId,
  request.destination,
  request.amount,
  request.fee,
].join(":");
const recomputed = createHash("sha256").update(preimage).digest();

check(
  "payload recomputes from the policy-approved fields",
  hex(recomputed) === request.payload_hex,
  `${hex(recomputed).slice(0, 16)}…`,
);

// 2. Ask the signer for the key that this contract + path derives.
const agent = await view(account, "get_agent", {
  owner: request.owner,
  public_key: request.agent_public_key,
});
const path = await view(account, "get_derivation_path", {
  owner: request.owner,
  public_key: request.agent_public_key,
  chain: request.chain,
});
const derived = await view(SIGNER, "derived_public_key", {
  path,
  predecessor: account,
  domain_id: 0,
});

check(
  "derivation path is bound to owner, agent and chain",
  path === `keyring-v1,${request.owner},${agent.label},${chainId}`,
  path,
);

// NEAR encodes a secp256k1 key as 64 bytes (x||y); SEC1 wants an 0x04 prefix.
const keyBytes = base58.decode(derived.split(":")[1]);
check("derived key is a 64-byte secp256k1 key", keyBytes.length === 64, `${keyBytes.length} bytes`);
const pubkey = new Uint8Array(65);
pubkey[0] = 0x04;
pubkey.set(keyBytes, 1);

// 3. Verify the ECDSA signature over the payload.
const bigR = Buffer.from(request.signature.big_r, "hex"); // compressed point
const r = bigR.subarray(1, 33); // x-coordinate is the signature's r
const s = Buffer.from(request.signature.s, "hex");
const compact = new Uint8Array(64);
compact.set(r, 0);
compact.set(s, 32);

const sig = secp256k1.Signature.fromCompact(compact);
check(
  "signature verifies against the derived public key",
  secp256k1.verify(sig, recomputed, pubkey),
);

// 4. Recover the key from the signature and confirm it is the same one.
//    This is the strongest check: it ties the signature to that exact key.
const recovered = sig
  .addRecoveryBit(request.signature.recovery_id)
  .recoverPublicKey(recomputed)
  .toRawBytes(false);
check(
  "public key recovered from the signature matches the derived key",
  hex(recovered) === hex(pubkey),
  `${hex(recovered).slice(0, 16)}…`,
);

const failed = checks.filter((c) => !c.ok);
console.log(
  `\n${failed.length === 0 ? "All checks passed" : `${failed.length} check(s) FAILED`}` +
    ` (${checks.length - failed.length}/${checks.length})\n`,
);
console.log(`  derived address key : ${derived}`);
console.log(`  signed payload      : ${request.payload_hex}\n`);
process.exit(failed.length === 0 ? 0 : 1);
