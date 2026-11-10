# Threat model

Scope: the Keyring contract, the SDK, the MCP server and the relayer path, as
implemented at **Gate C**. MPC signing is implemented and verified on testnet.
Foreign-chain transaction construction is not written yet, so threats against it
are listed as *deferred* with the gate that will address them, rather than
claimed as mitigated.

## Assets

| Asset | Why it matters |
|---|---|
| MPC-derived foreign-chain keys | Control real (testnet) funds. Never held by the contract or the agent. |
| Owner NEAR account | Root of authority. Can change policy, revoke agents. |
| Agent access key | Lets an agent request spending within policy. |
| Policy state | The limits themselves. Altering them alters authority. |
| Rolling spend ledger | The record that enforces the 24h cap. Under-counting it is equivalent to raising the cap. |
| Audit event stream | The evidence of what was decided and why. |

## Trust boundaries

```
 ┌───────────────────────────────────────────┐
 │ AI agent runtime            UNTRUSTED     │  prompt injection, tool misuse,
 │                                           │  leaked agent key
 └───────────────┬───────────────────────────┘
                 │  agent key, scoped to the contract
 ┌───────────────▼───────────────────────────┐
 │ MCP server / TypeScript SDK  SEMI-TRUSTED │  may send stale or malformed
 │                                           │  data; holds no authority
 └───────────────┬───────────────────────────┘
                 │  (chain, destination, amount, fee)
 ┌───────────────▼───────────────────────────┐
 │ Keyring contract                TRUSTED   │  ← enforcement boundary
 └───────────────┬───────────────────────────┘
                 │  deposit attached by the contract
 ┌───────────────▼───────────────────────────┐
 │ NEAR Chain Signatures MPC       EXTERNAL  │  threshold operators, liveness
 └───────────────┬───────────────────────────┘
                 │  signature
 ┌───────────────▼───────────────────────────┐
 │ Relayer + chain RPC         SEMI-TRUSTED  │  may fail, stall, or lie about
 │                                           │  broadcast and UTXO data
 └───────────────────────────────────────────┘
```

The single most important property: **everything above the contract is assumed
hostile or unreliable, and none of it can increase authorised spend or change a
recipient.**

## Threats

### T1 — A prompt-injected agent tries to pay an attacker

*Untrusted runtime.* An agent is manipulated into requesting a payment to an
address the owner never approved.

**Mitigated.** The destination must appear in the per-chain allowlist. An empty
allowlist permits nobody, never anybody. EVM addresses are normalised to
lowercase before comparison, so a mixed-case variant of an allowlisted address
cannot be used to smuggle in a different one — and a malformed address is
refused with `malformed_destination` rather than stored.

Tests: `non_allowlisted_destination_is_refused`, `empty_allowlist_permits_nobody`,
`evm_destination_comparison_is_case_insensitive`.

### T2 — A compromised agent key drains the balance

*Leaked credential.* An attacker obtains the agent's access key.

**Bounded, not prevented.** This is the core design assumption: the key is
valuable but limited. The attacker is confined to the per-request cap, the
rolling 24-hour cap, the destination allowlist, the chain allowlist and the time
window. The owner can disable the agent immediately.

**Residual risk:** an attacker can spend up to the remaining 24-hour budget to
an allowlisted destination before the owner notices. Keyring reduces blast
radius; it does not eliminate it. Allowlisting only addresses the owner controls
or genuinely intends to pay is what makes this bound meaningful.

Tests: `successive_requests_cannot_exceed_the_rolling_cap_in_aggregate`,
`a_disabled_agent_cannot_obtain_a_new_request`.

### T3 — An agent splits a large payment into many small ones

**Mitigated.** Every accepted request reserves against the rolling window, and
the cap is checked against the projected total, not the single amount. Reaching
the cap exactly is allowed; one base unit beyond is refused.

Tests: `daily_cap_accumulates_across_several_requests`,
`spend_exactly_reaching_daily_cap_is_allowed`,
`spend_one_base_unit_over_daily_cap_is_refused`.

### T4 — Concurrent requests race the budget check

**Mitigated by construction.** NEAR executes calls to one contract account
sequentially, and the reservation is written in the same call that authorises the
request. The second request therefore observes the first's reservation. There is
no read-then-write window in which both could pass.

This is why budget is reserved *before* any asynchronous signing: a design that
debited on callback would have exactly this race.

Test: `successive_requests_cannot_exceed_the_rolling_cap_in_aggregate`.

### T5 — A malicious relayer claims broadcast failure to recover budget

**Mitigated.** Nothing releases a reservation on a relayer's report. See
security decision 4.

**Residual risk:** a transfer that genuinely fails to broadcast still consumes
budget until the window rolls. This is an availability cost accepted to remove a
spending-integrity hole.

### T6 — The SDK or MCP server is modified to alter a payment

**Mitigated.** Neither holds authority. They serialise a request; the contract
re-validates every field and makes every decision. A hostile SDK can cause a
refusal or a failed transaction, not an over-limit payment.

Defence in depth: the MCP validator rejects amounts given as JSON numbers, so a
client cannot lose precision on the way in (security decision 12).

### T7 — A caller smuggles extra recipients or calldata into the signed payload

**Mitigated by interface design, verification deferred to Gate D/E.** No method
accepts calldata, a transaction preimage, an output list or a raw hash. A
request carries four fields: chain, destination, amount, fee.

Gate D/E must prove the constructed transaction matches those fields — EVM
transaction hash cross-checked against viem, Bitcoin sighash against a
bitcoinjs-lib fixture, outputs limited to the approved recipient plus change to
the derived Keyring address. **Until those tests exist, invariants 5–8 are
enforced by the absence of a dangerous parameter, not by a construction test.**

### T8 — An agent asks the MPC signer directly

**Mitigated, and verified on testnet.** The signer derives every key from its
own caller: it binds the key to `predecessor` plus `path`. Since only the
Keyring contract ever calls `sign`, only the Keyring contract can obtain
signatures for Keyring keys.

This was checked empirically, not assumed. Querying `derived_public_key` for the
same path with `predecessor` set to the agent account returns a **different**
key from the one bound to the contract. An agent that calls the signer directly
gets keys for its own account, which control nothing in Keyring.

The derivation path is computed by the contract from the owner, agent label and
chain, and is never a caller parameter, so an agent also cannot select another
agent's key.

### T9 — A non-owner changes policy or re-enables an agent

**Mitigated.** Every mutating method derives the owner from
`predecessor_account_id()`. `register_keyring` has no owner parameter at all. A
second owner with their own keyring still cannot reach the first owner's agent.

Tests: `non_owner_cannot_change_policy`, `non_owner_cannot_disable_an_agent`,
`non_owner_cannot_revoke_an_agent`,
`a_second_owner_cannot_touch_the_first_owners_agent`,
`an_owner_id_cannot_be_spoofed_by_a_parameter`.

### T10 — A duplicate request pays twice

**Partially mitigated.** An idempotency key is required and remembered; a replay
returns the original request and reserves no additional budget. Retention is
bounded at 32 keys per agent, so a reuse after many intervening requests is not
detected. See security decision 6 — the uncaught case is a second *within-policy*
payment, never an over-limit one.

Test: `a_repeated_idempotency_key_does_not_create_a_second_request`.

### T11 — Storage is inflated to make the contract unusable

**Mitigated.** Bounds on agents per keyring (16), destinations per chain (32),
chain policies (4), spend entries (64), idempotency records (32), history ids
(128), and lengths for labels, addresses and idempotency keys. Evicting a
history id deletes the corresponding request, so request storage is bounded per
keyring rather than growing with every request.

### T12 — Bitcoin fee cap is evaded via inflated UTXO values

**Not mitigated. Open.** See security decision 8. Must be resolved or
prominently documented before any Bitcoin claim is made.

### T13 — The MPC signer is unavailable, slow, or returns a signature nobody sees

**Mitigated.** The lifecycle `Created -> Signing -> Signed | Failed` is
implemented. `on_signed` is private and additionally enforces
`predecessor == current_account` explicitly, so the check is testable rather
than only present in the compiled wasm wrapper.

A failed or timed-out signing **retains** the budget reservation. The contract
cannot prove the MPC network never assembled a signature, so releasing budget
could authorise the same spend twice (security decision 16).

An unexpected Ed25519 response to a secp256k1 request is rejected and the
request marked `Failed`, rather than stored as though valid.

**Residual risk:** a genuinely failed signing consumes budget until the window
rolls. Invariant 12 is covered; invariant 14's duplicate-request case remains
bounded at 32 keys per agent (decision 6).

### T14 — Owner account compromise

**Out of scope, by the project contract.** The owner is the root of authority. A
compromised owner account can raise caps, allowlist an attacker address or
register a new agent. Keyring protects against a compromised *agent*, not a
compromised *owner*.

## Residual risks, stated plainly

1. A compromised agent key can spend the remaining 24-hour budget to an
   allowlisted destination.
2. Bitcoin fee caps rest on UTXO data the contract cannot verify (decision 8).
3. Replay protection is bounded at 32 keys per agent (decision 6).
4. A failed broadcast still consumes budget until the window rolls (decision 4).
5. Transaction-construction invariants (5–8) are not yet proven by construction
   tests — only by the absence of dangerous parameters. Gate D/E must close this.
6. A failed signing consumes budget until the window rolls (decision 16).
7. The mirrored MPC wire types must be re-checked whenever the signer contract
   is upgraded (decision 14).
8. No audit, no formal verification, no mainnet use.

## What has been verified, and how

| Claim | Evidence |
|---|---|
| Policy rules enforced at their boundaries | 30 unit tests, pure evaluator |
| Owner-only mutation, agent identity, aggregate budget | 28 tests in the near-sdk mock VM |
| MCP input validation | 12 Node tests |
| Contract compiles to wasm with ABI | `cargo near build`, 251.7 KB artifact |
| MPC lifecycle and callback access control | 14 tests, including wire-format pinning |
| Real MPC signing | **Verified on testnet.** `keyring-gatec-1794295861.testnet`, request 1, `mock: false` |
| Signature correctness | **Independently verified.** `scripts/verify-signature.mjs`, 8/8 checks |
| No direct agent-to-MPC path | **Verified.** The agent-derived key differs from the contract-derived key |
| Any foreign-chain transaction | **Not verified.** Not implemented; Gate C signs a domain-separated commitment, not a transaction |
| Broadcast to any chain | **Not verified.** Not implemented. |
