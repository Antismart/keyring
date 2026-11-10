#!/usr/bin/env node
/**
 * Independently verify a Keyring signature.
 *
 * Shares no code with the contract. It refetches the request from chain,
 * rebuilds the transaction with an independent library — viem for EVM,
 * bitcoinjs-lib for Bitcoin — recomputes the hash that should have been
 * signed, asks the MPC signer for the derived key, verifies the signature,
 * and recovers the public key from the signature to confirm it is that key.
 *
 * Usage:
 *   node scripts/verify-signature.mjs <keyring-account> <request-id> [network]
 *
 * Exits non-zero if any check fails.
 */

import * as bitcoin from "bitcoinjs-lib";
import { secp256k1 } from "@noble/curves/secp256k1";
import { base58 } from "@scure/base";

import {
  deriveBitcoinKey,
  evmAddressFromNearKey,
  signingHash,
  viewFunction,
} from "../packages/sdk/dist/index.js";

const [account, requestIdArg, network = "testnet"] = process.argv.slice(2);
if (!account || !requestIdArg) {
  console.error("usage: verify-signature.mjs <keyring-account> <request-id> [network]");
  process.exit(2);
}
const RPC = `https://rpc.${network}.near.org`;
const SIGNER = network === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet";

const checks = [];
function check(name, ok, detail = "") {
  checks.push(ok);
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const request = await viewFunction(RPC, account, "get_request", {
  request_id: Number(requestIdArg),
});
if (!request) throw new Error(`request ${requestIdArg} not found`);

const isToken = typeof request.asset === "object" && "erc20" in request.asset;
console.log(`\nVerifying ${account} request #${request.id} on ${network}\n`);
console.log("Request");
console.log(`  chain       ${request.chain}`);
console.log(`  asset       ${isToken ? `ERC-20 ${request.asset.erc20.token}` : "native"}`);
console.log(`  destination ${request.destination}`);
console.log(`  amount      ${request.amount}`);
console.log(`  fee         ${request.fee} (derived by the contract)`);
console.log(`  status      ${request.status}\n`);

console.log("Checks");
check("request reached the signed state", request.status === "signed", request.status);
check("a signature is recorded", Boolean(request.signature));
check(
  "the signature is not a mock",
  request.signature?.mock === false,
  request.signature?.mock ? "MOCK — not real MPC output" : "real signer output",
);
if (!request.signature) process.exit(1);

// The derivation path, and the key the signer derives for it.
const path = await viewFunction(RPC, account, "get_derivation_path", {
  owner: request.owner,
  public_key: request.agent_public_key,
  chain: request.chain,
});
const agent = await viewFunction(RPC, account, "get_agent", {
  owner: request.owner,
  public_key: request.agent_public_key,
});
const chainId = { base_sepolia: "base-sepolia", bitcoin_testnet4: "bitcoin-testnet4" }[
  request.chain
];
check(
  "derivation path binds owner, agent and chain",
  path === `keyring-v1,${request.owner},${agent.label},${chainId}`,
  path,
);

// Rebuild the transaction independently and recompute the signed hash.
let recomputed;
let expectedSigner;
if (request.chain === "base_sepolia") {
  recomputed = signingHash(request); // viem
  const derived = await viewFunction(RPC, SIGNER, "derived_public_key", {
    path,
    predecessor: account,
    domain_id: 0,
  });
  expectedSigner = { nearKey: derived, label: evmAddressFromNearKey(derived) };
} else if (request.chain === "bitcoin_testnet4") {
  const btc = request.params.bitcoin;
  const key = await deriveBitcoinKey({ path, predecessor: account, rpcUrl: RPC });
  check(
    "the registered Bitcoin key is the one the signer derives",
    agent.btc_pubkey === key.compressedPubkey,
    key.compressedPubkey,
  );
  const net = bitcoin.networks.testnet;
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(key.compressedPubkey, "hex"),
    network: net,
  });
  const change = BigInt(btc.input_value) - BigInt(request.amount) - BigInt(request.fee);
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from(btc.txid, "hex").reverse(), btc.vout, 0xffffffff);
  tx.addOutput(bitcoin.address.toOutputScript(request.destination, net), Number(request.amount));
  if (change > 0n) tx.addOutput(p2wpkh.output, Number(change));
  const scriptCode = bitcoin.payments.p2pkh({ hash: p2wpkh.hash }).output;
  recomputed = `0x${tx
    .hashForWitnessV0(0, scriptCode, Number(btc.input_value), bitcoin.Transaction.SIGHASH_ALL)
    .toString("hex")}`;
  expectedSigner = { nearKey: key.derivedPublicKey, label: key.address };
} else {
  throw new Error(`no independent reference implemented for ${request.chain}`);
}

check(
  "the signed hash recomputes from the approved fields",
  recomputed === `0x${request.payload_hex}`,
  `${recomputed.slice(0, 18)}…`,
);

// Verify the signature against the derived key, then recover it.
const keyBytes = base58.decode(expectedSigner.nearKey.split(":")[1]);
check("derived key is a 64-byte secp256k1 key", keyBytes.length === 64, `${keyBytes.length} bytes`);
const pubkey = new Uint8Array(65);
pubkey[0] = 0x04;
pubkey.set(keyBytes, 1);

const msg = Buffer.from(recomputed.slice(2), "hex");
const r = Buffer.from(request.signature.big_r.slice(2), "hex");
const s = Buffer.from(request.signature.s, "hex");
const compact = new Uint8Array(64);
compact.set(r, 0);
compact.set(s, 32);
const sig = secp256k1.Signature.fromCompact(compact);

check("signature verifies against the derived public key", secp256k1.verify(sig, msg, pubkey));

const recovered = sig
  .addRecoveryBit(request.signature.recovery_id)
  .recoverPublicKey(msg)
  .toRawBytes(false);
check(
  "public key recovered from the signature matches the derived key",
  Buffer.from(recovered).toString("hex") === Buffer.from(pubkey).toString("hex"),
);

const failed = checks.filter((ok) => !ok).length;
console.log(
  `\n${failed === 0 ? "All checks passed" : `${failed} check(s) FAILED`}` +
    ` (${checks.length - failed}/${checks.length})\n`,
);
console.log(`  Keyring address : ${expectedSigner.label}`);
console.log(`  signed payload  : 0x${request.payload_hex}\n`);
process.exit(failed === 0 ? 0 : 1);
