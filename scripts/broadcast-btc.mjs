#!/usr/bin/env node
/**
 * Assemble and broadcast a signed Keyring Bitcoin spend.
 *
 * Like the EVM relayer, this holds no authority: the contract decided what
 * may be sent and signed those exact bytes. Everything is checked before
 * anything is broadcast —
 *
 *   1. the request reached `signed` with a non-mock signature;
 *   2. the sighash, recomputed with bitcoinjs-lib, matches the contract's
 *      record;
 *   3. the signature verifies against the MPC-derived key;
 *   4. the assembled transaction's outputs are exactly the approved payment
 *      and change back to the Keyring address.
 *
 *   node scripts/broadcast-btc.mjs <keyring-account> <request-id> [api-base]
 */

import * as bitcoin from "bitcoinjs-lib";
import { secp256k1 } from "@noble/curves/secp256k1";
import { base58 } from "@scure/base";

import { deriveBitcoinKey, viewFunction } from "../packages/sdk/dist/index.js";

const [account, requestIdArg, API = "https://blockstream.info/testnet4/api"] =
  process.argv.slice(2);
if (!account || !requestIdArg) {
  console.error("usage: broadcast-btc.mjs <keyring-account> <request-id> [api-base]");
  process.exit(2);
}
const NEAR_RPC = "https://rpc.testnet.near.org";
const NET = bitcoin.networks.testnet; // testnet4 shares testnet's address format

const req = await viewFunction(NEAR_RPC, account, "get_request", {
  request_id: Number(requestIdArg),
});
if (!req) throw new Error(`request ${requestIdArg} not found`);
if (!("bitcoin" in req.params)) throw new Error(`request ${req.id} is not a Bitcoin spend`);
const btc = req.params.bitcoin;

console.log(`\nRequest #${req.id} on ${account}`);
console.log(`  to     ${req.destination}`);
console.log(`  amount ${req.amount} sat`);
console.log(`  fee    ${req.fee} sat (derived: inputs minus outputs)`);
console.log(`  input  ${btc.txid}:${btc.vout} = ${btc.input_value} sat`);
console.log(`  status ${req.status}  mock ${req.signature?.mock}\n`);

if (req.status !== "signed" || !req.signature) {
  throw new Error(`request has no signature (status ${req.status})`);
}
if (req.signature.mock) {
  throw new Error("mock signature: must never be broadcast");
}

console.log("Pre-broadcast checks");

// Rebuild the transaction exactly as the contract built it.
const agent = await viewFunction(NEAR_RPC, account, "get_agent", {
  owner: req.owner,
  public_key: req.agent_public_key,
});
const path = await viewFunction(NEAR_RPC, account, "get_derivation_path", {
  owner: req.owner,
  public_key: req.agent_public_key,
  chain: req.chain,
});
const key = await deriveBitcoinKey({ path, predecessor: account });

if (agent.btc_pubkey !== key.compressedPubkey) {
  throw new Error(
    `the registered Bitcoin key ${agent.btc_pubkey} is not the derived one ${key.compressedPubkey};` +
      " change would go to an address the Keyring does not control",
  );
}
console.log("  PASS  registered Bitcoin key matches the MPC-derived key");

const pubkey = Buffer.from(key.compressedPubkey, "hex");
const p2wpkh = bitcoin.payments.p2wpkh({ pubkey, network: NET });
const change = BigInt(btc.input_value) - BigInt(req.amount) - BigInt(req.fee);

const tx = new bitcoin.Transaction();
tx.version = 2;
tx.addInput(Buffer.from(btc.txid, "hex").reverse(), btc.vout, 0xffffffff);
tx.addOutput(bitcoin.address.toOutputScript(req.destination, NET), Number(req.amount));
if (change > 0n) tx.addOutput(p2wpkh.output, Number(change));

const scriptCode = bitcoin.payments.p2pkh({ hash: p2wpkh.hash }).output;
const sighash = tx.hashForWitnessV0(
  0,
  scriptCode,
  Number(btc.input_value),
  bitcoin.Transaction.SIGHASH_ALL,
);

console.log(`  contract recorded : 0x${req.payload_hex}`);
console.log(`  bitcoinjs recalc  : 0x${sighash.toString("hex")}`);
if (sighash.toString("hex") !== req.payload_hex) {
  console.error("  FAIL: sighash mismatch — refusing to broadcast");
  process.exit(1);
}
console.log("  PASS  sighash matches");

// Outputs must be the approved payment and change to the Keyring address.
const payScript = bitcoin.address.toOutputScript(req.destination, NET).toString("hex");
if (tx.outs[0].script.toString("hex") !== payScript || BigInt(tx.outs[0].value) !== BigInt(req.amount)) {
  throw new Error("first output is not the approved payment");
}
if (tx.outs.length > 1 && tx.outs[1].script.toString("hex") !== p2wpkh.output.toString("hex")) {
  throw new Error("change output does not pay the Keyring address");
}
if (tx.outs.length > 2) throw new Error("unexpected extra output");
console.log(`  PASS  outputs are the payment${tx.outs.length > 1 ? " and change to " + key.address : " only"}`);

// Bitcoin requires a low-S signature (BIP62); the MPC does not guarantee one,
// so normalise before encoding. Flipping s to n - s keeps the signature valid.
const r = Buffer.from(req.signature.big_r.slice(2), "hex");
const sBytes = Buffer.from(req.signature.s, "hex");
const compact = new Uint8Array(64);
compact.set(r, 0);
compact.set(sBytes, 32);
let sig = secp256k1.Signature.fromCompact(compact);
const wasHighS = sig.hasHighS();
if (wasHighS) sig = sig.normalizeS();
console.log(`  PASS  signature normalised to low-S${wasHighS ? " (was high-S)" : " (already low-S)"}`);

const raw64 = base58.decode(key.derivedPublicKey.split(":")[1]);
const uncompressed = new Uint8Array(65);
uncompressed[0] = 0x04;
uncompressed.set(raw64, 1);
if (!secp256k1.verify(sig, sighash, uncompressed)) {
  console.error("  FAIL: signature does not verify against the derived key");
  process.exit(1);
}
console.log("  PASS  signature verifies against the derived key");

// Witness: DER signature plus the SIGHASH_ALL byte, then the public key.
const derSig = Buffer.concat([Buffer.from(sig.toDERRawBytes()), Buffer.from([0x01])]);
tx.setWitness(0, [derSig, pubkey]);

const hex = tx.toHex();
console.log(`\nSigned transaction (${hex.length / 2} bytes), txid ${tx.getId()}\n  ${hex}\n`);

const res = await fetch(`${API}/tx`, { method: "POST", body: hex });
const body = (await res.text()).trim();
if (!res.ok) {
  console.error(`Broadcast failed (${res.status}): ${body}`);
  process.exit(1);
}
console.log(`Broadcast: ${body}`);
console.log(`  explorer: https://mempool.space/testnet4/tx/${body}\n`);
