#!/usr/bin/env node
/**
 * The Keyring demo: an agent operating through the MCP server.
 *
 * Drives the real MCP server over stdio against the deployed testnet contract
 * and writes a transcript to `evals/transcript.md`. Nothing here is mocked —
 * every tool call is a real contract call, the payment is a real Base Sepolia
 * transaction, and the refusals come from the contract's policy engine.
 *
 * The workflow is the one CLAUDE.md §13 asks for:
 *
 *   1. the agent discovers its address and its limits
 *   2. it simulates, then makes an allowed payment
 *   3. it attempts a disallowed payment and is refused with a precise reason
 *   4. the owner revokes it
 *   5. its next request fails, and the audit history shows every decision
 *
 * Step 4 deliberately does not use MCP: there is no revoke tool, because
 * revocation is the owner's authority, not the agent's.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { createSigningConnection, KeyringClient } from "../packages/sdk/dist/index.js";

const CONTRACT = process.env.KEYRING_CONTRACT_ID;
const OWNER = process.env.KEYRING_OWNER_ID ?? CONTRACT;
const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
const AGENT_PK = process.env.AGENT_PUBLIC_KEY;
const EVM_RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const DEST_ALLOWED = "0x1111111111111111111111111111111111111111";
const DEST_BLOCKED = "0x9999999999999999999999999999999999999999";

if (!CONTRACT || !OWNER_KEY || !AGENT_PK) {
  console.error("need KEYRING_CONTRACT_ID, OWNER_PRIVATE_KEY, AGENT_PUBLIC_KEY");
  process.exit(2);
}

/** Minimal stdio MCP client. */
class McpClient {
  #proc;
  #pending = new Map();
  #buffer = "";
  #nextId = 1;

  constructor(command, args, env) {
    this.#proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.#proc.stdout.on("data", (chunk) => {
      this.#buffer += chunk.toString();
      let idx;
      while ((idx = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, idx).trim();
        this.#buffer = this.#buffer.slice(idx + 1);
        if (!line.startsWith("{")) continue;
        const msg = JSON.parse(line);
        const resolve = this.#pending.get(msg.id);
        if (resolve) {
          this.#pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    this.#proc.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));
  }

  #send(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize() {
    const res = await this.#send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "keyring-demo", version: "0.1.0" },
    });
    return res.result;
  }

  async listTools() {
    return (await this.#send("tools/list", {})).result.tools;
  }

  /** Calls a tool and returns the parsed JSON payload it produced. */
  async callTool(name, args) {
    const res = await this.#send("tools/call", { name, arguments: args });
    if (res.error) return { _error: res.error.message };
    const text = res.result?.content?.[0]?.text ?? "{}";
    return { ...JSON.parse(text), _isError: res.result?.isError ?? false };
  }

  close() {
    this.#proc.stdin.end();
    this.#proc.kill();
  }
}

async function evmRpc(method, params) {
  const res = await fetch(EVM_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const transcript = [];
function step(title, detail) {
  console.log(`\n### ${title}`);
  if (detail) console.log(detail);
  transcript.push({ title, detail });
}
function record(label, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  console.log(text);
  transcript.push({ label, body: text });
}

const client = new McpClient("node", ["packages/mcp-server/dist/bin.js"], {
  KEYRING_AUTO_BROADCAST: "true",
});

const info = await client.initialize();
const tools = await client.listTools();

step(
  "0. The tool surface the agent is given",
  "Note what is absent: no tool registers an agent, changes a policy, re-enables a disabled one, or signs arbitrary data. Those are the owner's authority.",
);
record(
  "tools",
  tools.map((t) => `${t.name}  (readOnly: ${t.annotations?.readOnlyHint ?? false})`).join("\n"),
);

step("1. The agent discovers where it pays from and what it may do");
record("get_addresses", await client.callTool("get_addresses", {
  agent_public_key: AGENT_PK,
  chain: "base_sepolia",
}));
record("get_policy", await client.callTool("get_policy", { agent_public_key: AGENT_PK }));

// Live gas parameters for the derived address.
const addrInfo = await client.callTool("get_addresses", {
  agent_public_key: AGENT_PK,
  chain: "base_sepolia",
});
const from = addrInfo.address;
const nonce = BigInt(await evmRpc("eth_getTransactionCount", [from, "latest"]));
const gasPrice = BigInt(await evmRpc("eth_gasPrice", []));
const params = {
  evm: {
    nonce: nonce.toString(),
    gas_limit: "21000",
    max_fee_per_gas: (gasPrice * 2n + 1n).toString(),
    max_priority_fee_per_gas: (gasPrice / 2n).toString(),
  },
};
const AMOUNT = "500000000000";

step(
  "2. It simulates before spending",
  "A view call: reserves no budget and records nothing.",
);
record("simulate_transfer", await client.callTool("simulate_transfer", {
  agent_public_key: AGENT_PK,
  chain: "base_sepolia",
  destination: DEST_ALLOWED,
  amount: AMOUNT,
  params,
}));

step(
  "3. An allowed payment",
  "The contract checks policy, builds the EIP-1559 transaction itself, has the NEAR MPC network sign it, and the relayer broadcasts it.",
);
const paid = await client.callTool("request_transfer", {
  chain: "base_sepolia",
  destination: DEST_ALLOWED,
  amount: AMOUNT,
  params,
  idempotency_key: `demo-pay-${Date.now()}`,
});
record("request_transfer", paid);

if (paid.transaction_hash) {
  // Confirm inclusion from the chain, not from the tool's own report.
  let receipt = null;
  for (let i = 0; i < 45 && !receipt; i++) {
    receipt = await evmRpc("eth_getTransactionReceipt", [paid.transaction_hash]);
    if (!receipt) await new Promise((r) => setTimeout(r, 2000));
  }
  const tx = await evmRpc("eth_getTransactionByHash", [paid.transaction_hash]);
  record("independently verified on Base Sepolia", {
    from: tx.from,
    to: tx.to,
    value_wei: BigInt(tx.value).toString(),
    chain_id: Number(BigInt(tx.chainId)),
    block: receipt ? Number(BigInt(receipt.blockNumber)) : null,
    status: receipt?.status === "0x1" ? "success" : receipt?.status ?? "pending",
    explorer: `https://sepolia.basescan.org/tx/${paid.transaction_hash}`,
  });
}

step(
  "4. A disallowed payment is refused, with the rule that refused it",
  "The refusal is the product, not an error to hide. Nothing was signed and no budget was reserved.",
);
record("request_transfer (unallowlisted destination)", await client.callTool("request_transfer", {
  chain: "base_sepolia",
  destination: DEST_BLOCKED,
  amount: "1000",
  params,
  idempotency_key: `demo-refuse-${Date.now()}`,
}));

step("5. Inflated gas cannot buy a larger fee allowance");
record("request_transfer (gas far above the fee cap)", await client.callTool("request_transfer", {
  chain: "base_sepolia",
  destination: DEST_ALLOWED,
  amount: "1000",
  params: {
    evm: {
      nonce: nonce.toString(),
      gas_limit: "200000",
      max_fee_per_gas: "1000000000000",
      max_priority_fee_per_gas: "0",
    },
  },
  idempotency_key: `demo-fee-${Date.now()}`,
}));

step(
  "6. The owner revokes the agent",
  "Done with the owner's own key through the SDK. There is no MCP tool for this: revocation is not an authority the agent holds.",
);
const ownerClient = new KeyringClient({
  contractId: CONTRACT,
  connection: createSigningConnection({ accountId: OWNER, privateKey: OWNER_KEY }),
});
await ownerClient.revokeAgent(AGENT_PK);
record("owner action", `revoke_agent(${AGENT_PK}) — submitted by ${OWNER}`);

step("7. The revoked agent can no longer transact");
record("request_transfer after revocation", await client.callTool("request_transfer", {
  chain: "base_sepolia",
  destination: DEST_ALLOWED,
  amount: "1000",
  params,
  idempotency_key: `demo-after-revoke-${Date.now()}`,
}));

step("8. The audit history shows every decision");
record("get_history", await client.callTool("get_history", { limit: 10 }));

client.close();

// ---------------------------------------------------------------- transcript
mkdirSync("evals", { recursive: true });
const md = [
  "# Agent demo transcript",
  "",
  "Generated by `scripts/demo-agent.mjs`. Every call below is a real MCP tool",
  "call against a deployed NEAR testnet contract; the payment is a real Base",
  "Sepolia transaction. Nothing is mocked or edited.",
  "",
  `- Keyring contract: \`${CONTRACT}\``,
  `- MPC signer: \`v1.signer-prod.testnet\` (domain 0, secp256k1)`,
  `- MCP server: \`${info.serverInfo.name}\` v${info.serverInfo.version}`,
  `- Generated: ${new Date().toISOString()}`,
  "",
  "Regenerate with:",
  "",
  "```bash",
  "node scripts/demo-agent.mjs",
  "```",
  "",
  "> This transcript ends with the agent revoked, so re-running it requires",
  "> registering the agent again.",
  "",
];
for (const entry of transcript) {
  if (entry.title) {
    md.push(`## ${entry.title}`, "");
    if (entry.detail) md.push(entry.detail, "");
  } else {
    md.push(`**${entry.label}**`, "", "```json", entry.body, "```", "");
  }
}
writeFileSync("evals/transcript.md", `${md.join("\n")}\n`);
console.log("\n\nwrote evals/transcript.md");
