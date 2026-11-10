/**
 * Tool definitions and input validation for the Keyring MCP server.
 *
 * ## The tool surface is the attack surface
 *
 * An MCP server is called by an untrusted agent runtime (CLAUDE.md §4), so what
 * matters most here is what is *absent*. There is no tool to register an agent,
 * change a policy, enable an agent, or sign anything arbitrary. Every
 * privileged action stays with the owner, who performs it through the SDK or
 * CLI with their own NEAR key.
 *
 * The five tools below are exactly the capability an agent needs to spend
 * within limits and to understand a refusal — nothing more.
 *
 * Validation here is defence in depth, not enforcement: the contract re-checks
 * everything. Rejecting malformed input early just produces a clearer error
 * than a failed transaction would.
 */

import type { Asset, Chain, EvmParams } from "@keyring/sdk";

/** Names of the tools this server exposes. */
export const TOOL_NAMES = [
  "get_addresses",
  "get_policy",
  "simulate_transfer",
  "request_transfer",
  "get_history",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** A validation failure, with the field that caused it. */
export class ToolInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "ToolInputError";
  }
}

const CHAINS: readonly Chain[] = ["base_sepolia", "bitcoin_testnet4"];

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolInputError("input", "expected an object");
  }
  return value as Record<string, unknown>;
}

function requireString(input: Record<string, unknown>, field: string, maxLength: number): string {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(field, "expected a non-empty string");
  }
  if (value.length > maxLength) {
    throw new ToolInputError(field, `must be at most ${maxLength} characters`);
  }
  return value;
}

function requireChain(input: Record<string, unknown>, field: string): Chain {
  const value = input[field];
  if (typeof value !== "string" || !CHAINS.includes(value as Chain)) {
    throw new ToolInputError(field, `expected one of: ${CHAINS.join(", ")}`);
  }
  return value as Chain;
}

/**
 * Validates an amount in base units.
 *
 * Amounts must be decimal integer **strings**. A JSON number is rejected
 * outright rather than coerced: `Number` cannot represent large wei values
 * exactly, and silently rounding a payment amount is precisely the class of bug
 * CLAUDE.md §3 bans floating point to prevent.
 */
function requireBaseUnits(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value === "number") {
    throw new ToolInputError(
      field,
      "must be a decimal string, not a number — JavaScript numbers cannot represent base-unit amounts exactly",
    );
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new ToolInputError(field, "expected a decimal integer string in base units");
  }
  if (value.length > 1 && value.startsWith("0")) {
    throw new ToolInputError(field, "must not have leading zeros");
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new ToolInputError(field, "is not a valid integer");
  }
  if (parsed < 0n) {
    throw new ToolInputError(field, "must not be negative");
  }
  if (parsed > (1n << 128n) - 1n) {
    throw new ToolInputError(field, "exceeds the maximum u128 value");
  }
  return value;
}

/**
 * Validates the nested EVM transaction parameters.
 *
 * There is deliberately no `fee` field. The contract derives the fee as
 * `gas_limit * max_fee_per_gas`, so a caller cannot declare one fee and have a
 * transaction signed that authorises another.
 */
function requireEvmParams(input: Record<string, unknown>, field: string): { evm: EvmParams } {
  const raw = input[field];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ToolInputError(field, "expected an object");
  }
  const outer = raw as Record<string, unknown>;
  if (!("evm" in outer)) {
    throw new ToolInputError(field, "expected an 'evm' key for an EVM chain");
  }
  const evm = outer.evm;
  if (typeof evm !== "object" || evm === null || Array.isArray(evm)) {
    throw new ToolInputError(`${field}.evm`, "expected an object");
  }
  const e = evm as Record<string, unknown>;
  const params: EvmParams = {
    nonce: requireBaseUnits(e, "nonce"),
    gas_limit: requireBaseUnits(e, "gas_limit"),
    max_fee_per_gas: requireBaseUnits(e, "max_fee_per_gas"),
    max_priority_fee_per_gas: requireBaseUnits(e, "max_priority_fee_per_gas"),
  };
  // Mirrors the contract's own check so the agent gets a clear error here
  // rather than a failed transaction. The contract re-checks regardless.
  if (BigInt(params.max_priority_fee_per_gas) > BigInt(params.max_fee_per_gas)) {
    throw new ToolInputError(
      `${field}.evm.max_priority_fee_per_gas`,
      "must not exceed max_fee_per_gas",
    );
  }
  return { evm: params };
}

/**
 * Validates the asset being moved.
 *
 * Accepts the string `"native"` or `{ erc20: { token } }`. A token address is
 * checked for shape here only; the contract canonicalises it and matches it
 * against the agent's asset policy, which is what actually grants permission.
 */
function requireAsset(input: Record<string, unknown>, field: string): Asset {
  const raw = input[field];
  if (raw === "native") return "native";
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "erc20" in raw) {
    const inner = (raw as { erc20: unknown }).erc20;
    if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
      throw new ToolInputError(`${field}.erc20`, "expected an object with a token address");
    }
    const token = (inner as Record<string, unknown>).token;
    if (typeof token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
      throw new ToolInputError(`${field}.erc20.token`, "expected a 0x-prefixed 20-byte address");
    }
    return { erc20: { token } };
  }
  throw new ToolInputError(field, 'expected "native" or { erc20: { token } }');
}

export interface GetAddressesInput {
  owner: string;
  agent_public_key: string;
}

export interface GetPolicyInput {
  owner: string;
  agent_public_key: string;
}

export interface SimulateTransferInput {
  owner: string;
  agent_public_key: string;
  chain: Chain;
  asset: Asset;
  destination: string;
  amount: string;
  params: { evm: EvmParams };
}

export interface RequestTransferInput {
  chain: Chain;
  asset: Asset;
  destination: string;
  amount: string;
  params: { evm: EvmParams };
  idempotency_key: string;
}

export interface GetHistoryInput {
  owner: string;
  from_index?: number;
  limit?: number;
}

export function validateGetAddresses(raw: unknown): GetAddressesInput {
  const input = asRecord(raw);
  return {
    owner: requireString(input, "owner", 64),
    agent_public_key: requireString(input, "agent_public_key", 128),
  };
}

export function validateGetPolicy(raw: unknown): GetPolicyInput {
  const input = asRecord(raw);
  return {
    owner: requireString(input, "owner", 64),
    agent_public_key: requireString(input, "agent_public_key", 128),
  };
}

export function validateSimulateTransfer(raw: unknown): SimulateTransferInput {
  const input = asRecord(raw);
  return {
    owner: requireString(input, "owner", 64),
    agent_public_key: requireString(input, "agent_public_key", 128),
    chain: requireChain(input, "chain"),
    asset: requireAsset(input, "asset"),
    destination: requireString(input, "destination", 128),
    amount: requireBaseUnits(input, "amount"),
    params: requireEvmParams(input, "params"),
  };
}

export function validateRequestTransfer(raw: unknown): RequestTransferInput {
  const input = asRecord(raw);
  return {
    chain: requireChain(input, "chain"),
    asset: requireAsset(input, "asset"),
    destination: requireString(input, "destination", 128),
    amount: requireBaseUnits(input, "amount"),
    params: requireEvmParams(input, "params"),
    idempotency_key: requireString(input, "idempotency_key", 64),
  };
}

export function validateGetHistory(raw: unknown): GetHistoryInput {
  const input = asRecord(raw);
  const owner = requireString(input, "owner", 64);
  const result: GetHistoryInput = { owner };
  if (input.from_index !== undefined) {
    const n = input.from_index;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new ToolInputError("from_index", "expected a non-negative integer");
    }
    result.from_index = n;
  }
  if (input.limit !== undefined) {
    const n = input.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 100) {
      throw new ToolInputError("limit", "expected an integer between 1 and 100");
    }
    result.limit = n;
  }
  return result;
}

/** JSON Schemas advertised to the MCP client, one per tool. */
export const TOOL_SCHEMAS: Record<ToolName, { description: string; inputSchema: object }> = {
  get_addresses: {
    description:
      "Return the MPC derivation paths for an agent's keys. Read-only; does not move funds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "agent_public_key"],
      properties: {
        owner: { type: "string", description: "NEAR account id of the Keyring owner" },
        agent_public_key: { type: "string", description: "The agent's registered NEAR public key" },
      },
    },
  },
  get_policy: {
    description:
      "Return the spending policy that applies to an agent, including caps and allowed destinations. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "agent_public_key"],
      properties: {
        owner: { type: "string" },
        agent_public_key: { type: "string" },
      },
    },
  },
  simulate_transfer: {
    description:
      "Ask whether a transfer would be allowed, and if not, why. Reserves no budget and records nothing. Call this before request_transfer to avoid an avoidable refusal.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "agent_public_key", "chain", "asset", "destination", "amount", "params"],
      properties: {
        owner: { type: "string" },
        agent_public_key: { type: "string" },
        chain: { type: "string", enum: [...CHAINS] },
        asset: {
          description:
            'What to move: "native" for the chain coin, or { erc20: { token } } for a token.',
          oneOf: [
            { type: "string", enum: ["native"] },
            {
              type: "object",
              additionalProperties: false,
              required: ["erc20"],
              properties: {
                erc20: {
                  type: "object",
                  additionalProperties: false,
                  required: ["token"],
                  properties: { token: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
                },
              },
            },
          ],
        },
        destination: { type: "string", description: "Destination address in chain-native form" },
        amount: {
          type: "string",
          pattern: "^[0-9]+$",
          description: "Amount in base units (wei or satoshi) as a decimal string",
        },
        params: {
          type: "object",
          additionalProperties: false,
          required: ["evm"],
          description:
            "Chain-specific transaction inputs. No fee field: the contract derives the fee from gas_limit and max_fee_per_gas.",
          properties: {
            evm: {
              type: "object",
              additionalProperties: false,
              required: ["nonce", "gas_limit", "max_fee_per_gas", "max_priority_fee_per_gas"],
              properties: {
                nonce: { type: "string", pattern: "^[0-9]+$" },
                gas_limit: { type: "string", pattern: "^[0-9]+$" },
                max_fee_per_gas: { type: "string", pattern: "^[0-9]+$" },
                max_priority_fee_per_gas: { type: "string", pattern: "^[0-9]+$" },
              },
            },
          },
        },
      },
    },
  },
  request_transfer: {
    description:
      "Request a transfer within policy. The contract decides; a refusal is a normal result with a structured reason, not an error to retry blindly. Repeating the same idempotency_key returns the original request instead of paying twice.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["chain", "asset", "destination", "amount", "params", "idempotency_key"],
      properties: {
        chain: { type: "string", enum: [...CHAINS] },
        asset: {
          description:
            'What to move: "native" for the chain coin, or { erc20: { token } } for a token.',
          oneOf: [
            { type: "string", enum: ["native"] },
            {
              type: "object",
              additionalProperties: false,
              required: ["erc20"],
              properties: {
                erc20: {
                  type: "object",
                  additionalProperties: false,
                  required: ["token"],
                  properties: { token: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } },
                },
              },
            },
          ],
        },
        destination: { type: "string" },
        amount: { type: "string", pattern: "^[0-9]+$" },
        params: {
          type: "object",
          additionalProperties: false,
          required: ["evm"],
          description:
            "Chain-specific transaction inputs. No fee field: the contract derives the fee from gas_limit and max_fee_per_gas.",
          properties: {
            evm: {
              type: "object",
              additionalProperties: false,
              required: ["nonce", "gas_limit", "max_fee_per_gas", "max_priority_fee_per_gas"],
              properties: {
                nonce: { type: "string", pattern: "^[0-9]+$" },
                gas_limit: { type: "string", pattern: "^[0-9]+$" },
                max_fee_per_gas: { type: "string", pattern: "^[0-9]+$" },
                max_priority_fee_per_gas: { type: "string", pattern: "^[0-9]+$" },
              },
            },
          },
        },
        idempotency_key: {
          type: "string",
          maxLength: 64,
          description: "A unique key for this payment; reuse it to retry safely",
        },
      },
    },
  },
  get_history: {
    description:
      "Return recent transfer requests and their outcomes, newest first, including refusal reasons. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["owner"],
      properties: {
        owner: { type: "string" },
        from_index: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
};
