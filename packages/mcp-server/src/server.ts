/**
 * The Keyring MCP server.
 *
 * Exposes five narrowly scoped tools over stdio. The agent runtime calling
 * them is assumed hostile (CLAUDE.md §4), so the design principle is what is
 * *absent*: no tool registers an agent, changes a policy, re-enables a
 * disabled agent, or signs arbitrary data. Those are owner actions, performed
 * with the owner's own key through the SDK or CLI.
 *
 * The server is not an enforcement boundary. It validates inputs so an agent
 * gets a clear error instead of a failed transaction, and it refuses to
 * broadcast anything the contract did not approve — but every decision that
 * matters is made by the contract, which re-checks everything.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  broadcast,
  buildSignedTransaction,
  createSigningConnection,
  createViewConnection,
  deriveBitcoinKey,
  deriveEvmAddress,
  isRefused,
  KeyringClient,
  signingHash,
  verifySignedTransaction,
  type NearPrivateKey,
} from "@keyring/sdk";
import { z } from "zod";

import {
  validateGetHistory,
  validateRequestTransfer,
  validateSimulateTransfer,
} from "./tools.js";

/** Configuration read from the environment. No secret is ever logged. */
interface Config {
  contractId: string;
  nearRpcUrl: string;
  owner: string;
  agentAccountId: string | undefined;
  agentPrivateKey: NearPrivateKey | undefined;
  evmRpcUrl: string;
  /** When false, request_transfer is not registered at all. */
  canSign: boolean;
  /** When true, a signed transaction is broadcast automatically. */
  autoBroadcast: boolean;
}

function loadConfig(): Config {
  const contractId = process.env.KEYRING_CONTRACT_ID;
  if (!contractId) {
    throw new Error("KEYRING_CONTRACT_ID is required");
  }
  const owner = process.env.KEYRING_OWNER_ID ?? contractId;
  const agentAccountId = process.env.AGENT_ACCOUNT_ID;
  const agentPrivateKey = process.env.AGENT_PRIVATE_KEY as NearPrivateKey | undefined;
  return {
    contractId,
    owner,
    nearRpcUrl: process.env.NEAR_NODE_URL ?? "https://rpc.testnet.near.org",
    agentAccountId,
    agentPrivateKey,
    evmRpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    // Without an agent key the server can only read. Registering a spending
    // tool that is guaranteed to fail would be worse than not offering it.
    canSign: Boolean(agentAccountId && agentPrivateKey),
    autoBroadcast: process.env.KEYRING_AUTO_BROADCAST === "true",
  };
}

/**
 * Chain-specific transaction inputs, as either shape.
 *
 * There is no declared fee in either: the contract derives what the
 * transaction really pays and checks that against the cap.
 */
const CHAIN_PARAMS = z.union([
  z.object({
    evm: z.object({
      nonce: z.string(),
      gas_limit: z.string(),
      max_fee_per_gas: z.string(),
      max_priority_fee_per_gas: z.string(),
    }),
  }),
  z.object({
    bitcoin: z.object({
      txid: z.string().describe("Previous txid, 32 bytes of hex in display order"),
      vout: z.number().int().min(0),
      input_value: z.string().describe("The UTXO's value in satoshis"),
      fee: z.string().describe("Target fee in satoshis; the contract checks the real one"),
    }),
  }),
]);

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const failure = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
  isError: true,
});

export async function main(): Promise<void> {
  const config = loadConfig();
  const connection = config.canSign
    ? createSigningConnection({
        accountId: config.agentAccountId!,
        privateKey: config.agentPrivateKey!,
        rpcUrl: config.nearRpcUrl,
      })
    : createViewConnection(config.nearRpcUrl);
  const client = new KeyringClient({ contractId: config.contractId, connection });

  const server = new McpServer({ name: "keyring", version: "0.1.0" });

  server.registerTool(
    "get_addresses",
    {
      title: "Get Keyring addresses",
      description:
        "Return the derivation path and the derived blockchain address Keyring will pay from. Read-only.",
      inputSchema: {
        agent_public_key: z.string().describe("The agent's registered NEAR public key"),
        chain: z.enum(["base_sepolia", "bitcoin_testnet4"]),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agent_public_key, chain }) => {
      const path = await client.getDerivationPath(config.owner, agent_public_key, chain);
      if (!path) {
        return failure(`no agent registered with key ${agent_public_key}`);
      }
      if (chain === "bitcoin_testnet4") {
        const btc = await deriveBitcoinKey({
          path,
          predecessor: config.contractId,
          rpcUrl: config.nearRpcUrl,
        });
        const agent = await client.getAgent(config.owner, agent_public_key);
        return json({
          chain,
          derivation_path: path,
          address: btc.address,
          compressed_pubkey: btc.compressedPubkey,
          registered_with_contract: agent?.btc_pubkey === btc.compressedPubkey,
          note:
            agent?.btc_pubkey === btc.compressedPubkey
              ? "Ready: the contract can build change outputs for this agent."
              : "The owner must register this key with set_agent_btc_pubkey before Bitcoin spends can be built.",
        });
      }
      const derived = await deriveEvmAddress({
        path,
        predecessor: config.contractId,
        rpcUrl: config.nearRpcUrl,
      });
      return json({ chain, derivation_path: path, ...derived });
    },
  );

  server.registerTool(
    "get_policy",
    {
      title: "Get spending policy",
      description:
        "Return the policy governing an agent: allowed chains, allowed destinations, per-request cap, rolling 24-hour cap, fee cap and any time window. Read-only.",
      inputSchema: { agent_public_key: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ agent_public_key }) => {
      const agent = await client.getAgent(config.owner, agent_public_key);
      if (!agent) return failure(`no agent registered with key ${agent_public_key}`);
      return json({
        enabled: agent.enabled,
        label: agent.label,
        policy: agent.policy,
        aggregate_budget: await client.getAggregateBudget(config.owner),
        note: agent.enabled
          ? "Caps are per agent, per chain and per asset. aggregate_budget, when non-empty, additionally caps the total across all of this owner's agents."
          : "This agent is DISABLED by its owner; every request will be refused.",
      });
    },
  );

  server.registerTool(
    "simulate_transfer",
    {
      title: "Simulate a transfer",
      description:
        "Ask whether a transfer would be allowed, and if not, exactly which rule refuses it. Reserves no budget and records nothing. Call this before request_transfer to avoid an avoidable refusal.",
      inputSchema: {
        agent_public_key: z.string(),
        chain: z.enum(["base_sepolia", "bitcoin_testnet4"]),
        asset: z
          .union([z.literal("native"), z.object({ erc20: z.object({ token: z.string() }) })])
          .describe('"native" for the chain coin, or { erc20: { token } } for a token'),
        destination: z.string(),
        amount: z.string().describe("Amount in the asset's base units, as a decimal string"),
        params: CHAIN_PARAMS,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const input = validateSimulateTransfer({ owner: config.owner, ...args });
        const result = await client.simulateTransfer(config.owner, input.agent_public_key, {
          chain: input.chain,
          asset: input.asset,
          destination: input.destination,
          amount: input.amount,
          params: input.params,
        });
        return json(result);
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "get_history",
    {
      title: "Get request history",
      description:
        "Return recent transfer requests and their outcomes, newest first, including the structured reason for every refusal. Read-only.",
      inputSchema: {
        from_index: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const input = validateGetHistory({ owner: config.owner, ...args });
        const history = await client.getHistory(config.owner, {
          ...(input.from_index !== undefined ? { fromIndex: input.from_index } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        return json(
          history.map((r) => ({
            id: r.id,
            status: r.status,
            chain: r.chain,
            destination: r.destination,
            asset: r.asset,
            amount: r.amount,
            fee: r.fee,
            refusal: r.refusal,
            signature_is_mock: r.signature?.mock ?? null,
          })),
        );
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Registered only when an agent key is configured. An agent cannot be
  // tricked into calling a tool that does not exist.
  if (config.canSign) {
    server.registerTool(
      "request_transfer",
      {
        title: "Request a transfer",
        description:
          "Request a payment within policy. The contract decides: a refusal is a normal result carrying the rule that refused it, not an error to retry blindly. Reusing an idempotency_key returns the original request instead of paying twice. There is no fee argument — the contract derives the fee from the gas parameters.",
        inputSchema: {
          chain: z.enum(["base_sepolia", "bitcoin_testnet4"]),
          asset: z
            .union([z.literal("native"), z.object({ erc20: z.object({ token: z.string() }) })])
            .describe('"native" for the chain coin, or { erc20: { token } } for a token'),
          destination: z.string(),
          amount: z.string(),
          params: CHAIN_PARAMS,
          idempotency_key: z.string().max(64),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        try {
          const input = validateRequestTransfer(args);
          const outcome = await client.requestTransfer({
            chain: input.chain,
            asset: input.asset,
            destination: input.destination,
            amount: input.amount,
            params: input.params,
            idempotencyKey: input.idempotency_key,
          });

          if (isRefused(outcome)) {
            return json({
              outcome: "refused",
              request_id: outcome.request_id,
              refusal: outcome.refusal,
              note: "The policy refused this request. Nothing was signed and no budget was reserved.",
            });
          }
          if (outcome.outcome !== "signed") {
            return json(outcome);
          }

          const request = await client.getRequest(outcome.request_id);
          if (!request) return failure(`request ${outcome.request_id} vanished after signing`);

          if (!config.autoBroadcast) {
            return json({
              outcome: "signed",
              request_id: request.id,
              signing_hash: `0x${request.payload_hex}`,
              note: "Signed but not broadcast. Set KEYRING_AUTO_BROADCAST=true, or broadcast with scripts/broadcast-evm.mjs.",
            });
          }

          // Never broadcast bytes the contract did not approve.
          const recomputed = signingHash(request);
          if (`0x${request.payload_hex}` !== recomputed) {
            return failure(
              `refusing to broadcast: recomputed hash ${recomputed} does not match the contract's record`,
            );
          }
          const raw = buildSignedTransaction(request);
          verifySignedTransaction(request, raw);
          const txHash = await broadcast(config.evmRpcUrl, raw);

          return json({
            outcome: "signed_and_broadcast",
            request_id: request.id,
            destination: request.destination,
            amount: request.amount,
            transaction_hash: txHash,
            note: "Broadcast only. Inclusion in a block is not confirmed here.",
          });
        } catch (err) {
          return failure(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
}
