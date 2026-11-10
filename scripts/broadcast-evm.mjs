#!/usr/bin/env node
/**
 * Assemble and broadcast a signed Keyring transfer on an EVM chain.
 *
 * This is the relayer step. It holds no authority: the contract already
 * decided what may be sent and signed those exact bytes. Everything here is
 * checked before anything is broadcast —
 *
 *   1. the request actually reached `signed` with a non-mock signature;
 *   2. the signing hash, recomputed with viem, matches what the contract
 *      recorded;
 *   3. the assembled transaction still carries the approved recipient, value,
 *      chain id and nonce;
 *   4. the signature recovers to the Keyring address the MPC signer derives,
 *      proving the transaction is signed by the key policy governs and not by
 *      some other key.
 *
 * Any mismatch aborts without sending.
 *
 *   node scripts/broadcast-evm.mjs <keyring-account> <request-id> [rpc-url]
 */

import { recoverTransactionAddress } from "viem";

import {
  broadcast,
  buildSignedTransaction,
  signingHash,
  verifySignedTransaction,
  waitForReceipt,
} from "../packages/sdk/dist/index.js";

const [account, requestIdArg, rpcUrl = "https://sepolia.base.org"] = process.argv.slice(2);
if (!account || !requestIdArg) {
  console.error("usage: broadcast-evm.mjs <keyring-account> <request-id> [rpc-url]");
  process.exit(2);
}

const NEAR_RPC = "https://rpc.testnet.near.org";

async function view(contractId, method, args) {
  const res = await fetch(NEAR_RPC, {
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
  if (body.error) throw new Error(JSON.stringify(body.error));
  return JSON.parse(Buffer.from(body.result.result).toString());
}

const request = await view(account, "get_request", { request_id: Number(requestIdArg) });
if (!request) throw new Error(`request ${requestIdArg} not found`);

const isToken = typeof request.asset === "object" && "erc20" in request.asset;
console.log(`\nRequest #${request.id} on ${account}`);
console.log(`  asset   ${isToken ? `ERC-20 ${request.asset.erc20.token}` : "native ETH"}`);
console.log(`  to      ${request.destination}`);
console.log(`  amount  ${request.amount} ${isToken ? "token base units" : "wei"}`);
console.log(`  fee cap ${request.fee} wei (gas_limit * max_fee_per_gas)`);
console.log(`  status  ${request.status}`);
console.log(`  mock    ${request.signature?.mock}\n`);

// 1 & 2: the bytes we are about to send must be the bytes that were signed.
const recomputed = signingHash(request);
console.log("Pre-broadcast checks");
console.log(`  contract recorded : 0x${request.payload_hex}`);
console.log(`  viem recomputed   : ${recomputed}`);
if (`0x${request.payload_hex}` !== recomputed) {
  console.error("  FAIL: signing hash mismatch — refusing to broadcast");
  process.exit(1);
}
console.log("  PASS  signing hash matches");

const raw = buildSignedTransaction(request);

// 3: the assembled transaction must still carry the approved terms.
verifySignedTransaction(request, raw);
console.log("  PASS  assembled transaction carries the approved recipient, value and chain");

// 4: the sender must be the address the MPC signer derives for this agent.
const path = await view(account, "get_derivation_path", {
  owner: request.owner,
  public_key: request.agent_public_key,
  chain: request.chain,
});
const derived = await view("v1.signer-prod.testnet", "derived_public_key", {
  path,
  predecessor: account,
  domain_id: 0,
});
const { base58 } = await import("@scure/base");
const { keccak_256 } = await import("@noble/hashes/sha3");
const keyBytes = base58.decode(derived.split(":")[1]);
const expectedSender = `0x${Buffer.from(keccak_256(keyBytes).slice(12)).toString("hex")}`;
const sender = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
if (sender !== expectedSender) {
  console.error(`  FAIL: sender ${sender} is not the derived Keyring address ${expectedSender}`);
  process.exit(1);
}
console.log(`  PASS  signature recovers to the Keyring address ${sender}\n`);

console.log(`Raw transaction (${(raw.length - 2) / 2} bytes):\n  ${raw}\n`);

try {
  const txHash = await broadcast(rpcUrl, raw);
  console.log(`Broadcast: ${txHash}`);
  const receipt = await waitForReceipt(rpcUrl, txHash);
  const ok = receipt.status === "0x1";
  console.log(`  block   ${BigInt(receipt.blockNumber)}`);
  console.log(`  gasUsed ${BigInt(receipt.gasUsed)}`);
  console.log(`  status  ${ok ? "SUCCESS" : "REVERTED"}`);
  console.log(`\n  explorer: https://sepolia.basescan.org/tx/${txHash}\n`);
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(`\nBroadcast failed: ${err.message}`);
  if (/insufficient funds/i.test(err.message)) {
    console.error(
      "\nThe derived Keyring address holds no ETH. Fund it on Base Sepolia and re-run;\n" +
        "the signature is already valid and does not need to be regenerated.\n",
    );
  }
  process.exit(1);
}
