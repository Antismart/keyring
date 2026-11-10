/** Tests for the SDK's outcome narrowing helpers. */

import assert from "node:assert/strict";
import { test } from "node:test";

// Imported from the built output, so these tests exercise exactly what consumers get.
import { isCreated, isRefused, type RequestOutcome } from "../dist/index.js";

test("a refusal is a resolved outcome, not an error", () => {
  const refused: RequestOutcome = {
    outcome: "refused",
    request_id: 7,
    refusal: {
      code: "daily_cap_exceeded",
      rule: "rolling_24h_cap",
      message: "over cap",
      limit: "2000000000000000000",
      observed: "2000000000000000001",
    },
  };
  assert.ok(isRefused(refused));
  assert.ok(!isCreated(refused));
  // Callers must be able to read the limit and the observed value.
  assert.equal(refused.refusal.limit, "2000000000000000000");
});

test("a created outcome narrows to its reserved amount", () => {
  const created: RequestOutcome = { outcome: "created", request_id: 1, reserved: "5" };
  assert.ok(isCreated(created));
  assert.equal(created.reserved, "5");
});

test("a duplicate outcome is neither created nor refused", () => {
  const dup: RequestOutcome = { outcome: "duplicate", request_id: 3 };
  assert.ok(!isCreated(dup));
  assert.ok(!isRefused(dup));
});
