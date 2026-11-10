#!/usr/bin/env node
/**
 * Generate Bitcoin reference fixtures with bitcoinjs-lib.
 *
 * CLAUDE.md §7 requires the contract's sighash to be cross-checked against an
 * independent bitcoinjs-lib fixture. bitcoinjs-lib shares no code with the Rust
 * implementation in `contracts/keyring/src/bitcoin.rs`.
 *
 * Scope: single-input native-segwit (P2WPKH) spends, which is the simplest
 * spend type that can be verified safely, with one payment output and an
 * optional change output back to the Keyring address.
 *
 *   node scripts/gen-btc-fixtures.mjs          # write
 *   node scripts/gen-btc-fixtures.mjs --check  # fail if it would change
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as bitcoin from "bitcoinjs-lib";

const NET = bitcoin.networks.testnet; // testnet4 shares testnet's `tb` prefix
const SIGHASH_ALL = bitcoin.Transaction.SIGHASH_ALL;
/** Sequence used for every input: final, no RBF, so encoding is deterministic. */
const SEQUENCE = 0xffffffff;

/** The Keyring-controlled key whose address receives change. */
const KEYRING_PUBKEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/**
 * The payment destination, derived from a *different* key.
 *
 * Deliberately not the Keyring address: a fixture that paid to itself would
 * not distinguish the payment output from the change output, and could hide a
 * bug that swapped them.
 */
const DEST_PUBKEY = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

function destAddress() {
  return bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(DEST_PUBKEY, "hex"),
    network: NET,
  }).address;
}

function keyringP2wpkh() {
  const pubkey = Buffer.from(KEYRING_PUBKEY, "hex");
  const p = bitcoin.payments.p2wpkh({ pubkey, network: NET });
  return { address: p.address, hash160: p.hash.toString("hex"), script: p.output.toString("hex") };
}

/** Addresses whose scriptPubKey the contract must derive without help. */
const addressCases = [
  keyringP2wpkh().address,
  destAddress(),
  "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
  // Negative cases: a corrupted checksum and a mainnet address.
  "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsy",
  "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
].filter((a, i, arr) => arr.indexOf(a) === i);

const addresses = [];
for (const addr of addressCases) {
  try {
    addresses.push({
      address: addr,
      script_pubkey: bitcoin.address.toOutputScript(addr, NET).toString("hex"),
    });
  } catch {
    // Not a valid address; recorded as a negative case instead.
    addresses.push({ address: addr, script_pubkey: null });
  }
}

/**
 * Builds a single-input P2WPKH spend and returns its BIP143 sighash.
 *
 * The scriptCode for a P2WPKH input is the equivalent P2PKH script over the
 * same key hash — a detail that is easy to get wrong and is exactly why this
 * fixture exists.
 */
function spend({ name, note, txid, vout, inputValue, payTo, payAmount, changeAmount }) {
  const keyring = keyringP2wpkh();
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from(txid, "hex").reverse(), vout, SEQUENCE);
  tx.addOutput(bitcoin.address.toOutputScript(payTo, NET), payAmount);
  if (changeAmount !== null) {
    tx.addOutput(Buffer.from(keyring.script, "hex"), changeAmount);
  }
  const scriptCode = bitcoin.payments.p2pkh({
    hash: Buffer.from(keyring.hash160, "hex"),
  }).output;
  const sighash = tx.hashForWitnessV0(0, scriptCode, inputValue, SIGHASH_ALL);
  return {
    name,
    note,
    txid,
    vout,
    input_value: String(inputValue),
    pay_to: payTo,
    pay_amount: String(payAmount),
    change_amount: changeAmount === null ? null : String(changeAmount),
    keyring_pubkey: KEYRING_PUBKEY,
    keyring_address: keyring.address,
    keyring_hash160: keyring.hash160,
    script_code: scriptCode.toString("hex"),
    sequence: SEQUENCE,
    version: 2,
    locktime: 0,
    sighash: sighash.toString("hex"),
    unsigned_tx: tx.toHex(),
  };
}

const spends = [
  spend({
    name: "payment_with_change",
    note: "the ordinary case: one input, a payment and change back to Keyring",
    txid: "7f3e2a1b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7",
    vout: 1,
    inputValue: 100_000,
    payTo: destAddress(),
    payAmount: 60_000,
    changeAmount: 39_000,
  }),
  spend({
    name: "payment_without_change",
    note: "change below dust is omitted, so the remainder becomes fee",
    txid: "0000000000000000000000000000000000000000000000000000000000000001",
    vout: 0,
    inputValue: 60_200,
    payTo: destAddress(),
    payAmount: 60_000,
    changeAmount: null,
  }),
  spend({
    name: "high_vout_and_large_values",
    note: "a large vout index and values near the 8-byte boundary",
    txid: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    vout: 4_294_967_295,
    inputValue: 2_100_000_000_000,
    payTo: destAddress(),
    payAmount: 1_000_000_000_000,
    changeAmount: 1_099_999_000_000,
  }),
];

// The property that makes the Bitcoin fee cap enforceable: BIP143 commits the
// input amount, so a relayer that misreports it produces a signature that does
// not verify and a transaction the network rejects.
const base = spends[0];
const amountSensitivity = {
  note: "same transaction, different claimed input value: the sighash must differ",
  input_value_a: base.input_value,
  sighash_a: base.sighash,
  input_value_b: String(Number(base.input_value) + 1),
  sighash_b: spend({ ...base, name: "x", note: "x", inputValue: Number(base.input_value) + 1, payTo: base.pay_to, payAmount: Number(base.pay_amount), changeAmount: Number(base.change_amount) }).sighash,
};

const output =
  JSON.stringify(
    {
      _comment:
        "Generated by scripts/gen-btc-fixtures.mjs using bitcoinjs-lib. Do not edit by hand.",
      bitcoinjs_version: JSON.parse(
        readFileSync(new URL("../node_modules/bitcoinjs-lib/package.json", import.meta.url)),
      ).version,
      addresses,
      spends,
      amount_sensitivity: amountSensitivity,
    },
    null,
    2,
  ) + "\n";

const target = new URL("../contracts/keyring/tests/fixtures/bitcoin.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) {
    console.error("FAIL: committed Bitcoin fixtures differ from freshly generated ones");
    process.exit(1);
  }
  console.log(`OK: ${spends.length} spends and ${addresses.length} addresses match`);
} else {
  writeFileSync(target, output);
  console.log(`wrote ${spends.length} spends, ${addresses.length} addresses`);
}
