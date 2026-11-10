/**
 * Tests for MCP tool input validation.
 *
 * These guard the boundary between an untrusted agent runtime and the contract.
 * They are not a substitute for contract-side enforcement; they prove the server
 * rejects malformed input clearly instead of forwarding it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ToolInputError,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  validateGetHistory,
  validateRequestTransfer,
  validateSimulateTransfer,
} from "../dist/tools.js";

const VALID_PARAMS = {
  evm: {
    nonce: "0",
    gas_limit: "21000",
    max_fee_per_gas: "1000000000",
    max_priority_fee_per_gas: "1000000",
  },
};

const VALID_TRANSFER = {
  chain: "base_sepolia",
  asset: "native",
  destination: "0x1111111111111111111111111111111111111111",
  amount: "1000000000000000000",
  params: VALID_PARAMS,
  idempotency_key: "invoice-42",
};

test("a well-formed transfer request validates", () => {
  const out = validateRequestTransfer(VALID_TRANSFER);
  assert.equal(out.chain, "base_sepolia");
  assert.equal(out.amount, "1000000000000000000");
  assert.equal(out.idempotency_key, "invoice-42");
});

test("an amount given as a JSON number is rejected, not coerced", () => {
  // 1e18 is not exactly representable; coercing it would silently change the
  // payment amount.
  assert.throws(
    () => validateRequestTransfer({ ...VALID_TRANSFER, amount: 1e18 }),
    (err: unknown) => err instanceof ToolInputError && err.field === "amount",
  );
});

test("a fractional or negative amount is rejected", () => {
  for (const amount of ["0.5", "-1", "1e18", "", "abc", "0x10"]) {
    assert.throws(
      () => validateRequestTransfer({ ...VALID_TRANSFER, amount }),
      (err: unknown) => err instanceof ToolInputError,
      `amount ${JSON.stringify(amount)} should be rejected`,
    );
  }
});

test("an amount with leading zeros is rejected so one value has one encoding", () => {
  assert.throws(
    () => validateRequestTransfer({ ...VALID_TRANSFER, amount: "0100" }),
    (err: unknown) => err instanceof ToolInputError && err.field === "amount",
  );
});

test("zero is a syntactically valid amount; the contract refuses it on policy", () => {
  // Validation is syntax only. Business rules stay in the contract, so that the
  // server cannot become a second, divergent policy authority.
  const out = validateRequestTransfer({ ...VALID_TRANSFER, amount: "0" });
  assert.equal(out.amount, "0");
});

test("an amount above u128 is rejected", () => {
  const tooBig = (1n << 128n).toString();
  assert.throws(
    () => validateRequestTransfer({ ...VALID_TRANSFER, amount: tooBig }),
    (err: unknown) => err instanceof ToolInputError && err.field === "amount",
  );
});

test("an unknown chain is rejected", () => {
  assert.throws(
    () => validateRequestTransfer({ ...VALID_TRANSFER, chain: "solana_devnet" }),
    (err: unknown) => err instanceof ToolInputError && err.field === "chain",
  );
});

test("an over-long idempotency key is rejected", () => {
  assert.throws(
    () => validateRequestTransfer({ ...VALID_TRANSFER, idempotency_key: "x".repeat(65) }),
    (err: unknown) => err instanceof ToolInputError && err.field === "idempotency_key",
  );
});

test("non-object input is rejected", () => {
  for (const raw of [null, undefined, 42, "string", []]) {
    assert.throws(() => validateRequestTransfer(raw), (err: unknown) => err instanceof ToolInputError);
  }
});

test("simulate_transfer requires owner and agent key", () => {
  assert.throws(
    () => validateSimulateTransfer({ ...VALID_TRANSFER, owner: "owner.testnet" }),
    (err: unknown) => err instanceof ToolInputError && err.field === "agent_public_key",
  );
  const ok = validateSimulateTransfer({
    owner: "owner.testnet",
    agent_public_key: "ed25519:abc",
    chain: "base_sepolia",
    destination: VALID_TRANSFER.destination,
    amount: "1",
    asset: "native",
    params: VALID_PARAMS,
  });
  assert.equal(ok.owner, "owner.testnet");
});

test("history paging bounds are enforced", () => {
  assert.deepEqual(validateGetHistory({ owner: "o.testnet" }), { owner: "o.testnet" });
  assert.equal(validateGetHistory({ owner: "o.testnet", limit: 100 }).limit, 100);
  for (const limit of [0, 101, -1, 1.5]) {
    assert.throws(
      () => validateGetHistory({ owner: "o.testnet", limit }),
      (err: unknown) => err instanceof ToolInputError && err.field === "limit",
    );
  }
});

test("the exposed tool surface is exactly the five read/spend tools", () => {
  // A regression guard: adding a policy-mutation or raw-signing tool here would
  // hand the untrusted agent runtime authority the contract design denies it.
  assert.deepEqual([...TOOL_NAMES], [
    "get_addresses",
    "get_policy",
    "simulate_transfer",
    "request_transfer",
    "get_history",
  ]);
  assert.deepEqual(Object.keys(TOOL_SCHEMAS).sort(), [...TOOL_NAMES].sort());
});

test("there is no fee field to declare: the contract derives it", () => {
  // The caller supplies gas numbers; fee = gas_limit * max_fee_per_gas is
  // computed on chain. A caller cannot declare a small fee and have a
  // transaction signed that authorises a large one.
  const out = validateRequestTransfer(VALID_TRANSFER);
  assert.ok(!("fee" in out));
  assert.equal(out.params.evm.gas_limit, "21000");
  assert.equal(out.params.evm.max_fee_per_gas, "1000000000");
});

test("a tip above the fee cap is rejected, matching the contract and viem", () => {
  assert.throws(
    () =>
      validateRequestTransfer({
        ...VALID_TRANSFER,
        params: {
          evm: { ...VALID_PARAMS.evm, max_priority_fee_per_gas: "2000000000" },
        },
      }),
    (err: unknown) => err instanceof ToolInputError,
  );
});

test("gas parameters must be decimal strings, not numbers", () => {
  assert.throws(
    () =>
      validateRequestTransfer({
        ...VALID_TRANSFER,
        params: { evm: { ...VALID_PARAMS.evm, gas_limit: 21000 } },
      }),
    (err: unknown) => err instanceof ToolInputError,
  );
});

test("missing EVM params are rejected", () => {
  assert.throws(
    () => validateRequestTransfer({ ...VALID_TRANSFER, params: {} }),
    (err: unknown) => err instanceof ToolInputError && err.field === "params",
  );
});

test("an ERC-20 asset validates and keeps its token address", () => {
  const out = validateRequestTransfer({
    ...VALID_TRANSFER,
    asset: { erc20: { token: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } },
  });
  assert.deepEqual(out.asset, {
    erc20: { token: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  });
});

test("a malformed token address is rejected", () => {
  for (const token of ["0x123", "not-an-address", "", "0xZZZZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
    assert.throws(
      () => validateRequestTransfer({ ...VALID_TRANSFER, asset: { erc20: { token } } }),
      (err: unknown) => err instanceof ToolInputError,
      `token ${JSON.stringify(token)} should be rejected`,
    );
  }
});

test("an unknown asset shape is rejected", () => {
  for (const asset of ["eth", {}, { erc721: { token: "0x" } }, null, 1]) {
    assert.throws(
      () => validateRequestTransfer({ ...VALID_TRANSFER, asset }),
      (err: unknown) => err instanceof ToolInputError,
    );
  }
});
