# Security decisions

Decisions that affect trust or security, with the reasoning behind each. Entries
are append-only; when a decision is revised, the old entry stays and a new one
supersedes it.

Status key: **Settled** — decided and implemented. **Open** — decided for now,
expected to change at a named gate.

---

## 1. Agents are identified by public key, not by account id

**Settled.** An agent is registered as a NEAR `PublicKey`, and
`request_transfer` identifies the caller with `env::signer_account_pk()`.

An account id would be the weaker choice: several keys can act for one account,
and an owner handing an agent a sub-account could not scope it further. Keying
on the public key means the registered key is the whole credential, and the
owner can revoke exactly that key. It is also what makes the intended deployment
safe — a function-call access key scoped to the Keyring contract and its agent
methods only.

Covers invariant 1.

## 2. Agent public keys are globally unique across the contract

**Settled.** A `PublicKey -> AccountId` index rejects registering a key that is
already registered under any keyring.

Without it, the same key could be registered under two owners and
`request_transfer` could not say unambiguously which agent is calling. It would
have to pick one, and either choice would let one owner's policy be evaluated
against another owner's budget.

## 3. A policy refusal is a return value, not a panic

**Settled.** `request_transfer` returns `RequestOutcome::Refused` rather than
aborting.

A NEAR panic rolls back state, which would discard the audit record of the
refusal and the emitted event — exactly the evidence the product is supposed to
produce. The cost is that callers must discriminate on the `outcome` field; an
SDK consumer who treats any resolved promise as success will misreport a refused
payment as a completed one. This is called out in the SDK types and in the MCP
tool description.

## 4. Budget is reserved at authorisation, never credited back on report

**Settled.** A request that passes policy records a `SpendEntry` before any
asynchronous work begins. Nothing in the contract releases a reservation on a
relayer's word.

The contract cannot observe a foreign chain. A relayer reporting "broadcast
failed" may be wrong, lying, or describing a transaction that is already in a
mempool. Refunding on that report would let a malicious relayer mint spending
capacity by claiming failure after each signature. Treating an unbroadcast
signature as spent is the conservative error.

Covers invariants 10, 11 and 13.

## 5. A full spend ledger refuses rather than evicting an entry

**Settled.** The rolling ledger holds at most `MAX_SPEND_ENTRIES` (64) live
entries per chain. When full of unexpired entries, the next request is refused
with `budget_ledger_full`.

Evicting the oldest live entry would be the convenient choice and a direct
bypass of the 24-hour cap: an agent could exceed its daily limit by making many
small requests until old ones were dropped from the count. Refusing is
inconvenient and correct. Only expired entries are ever removed, which cannot
change the in-window total.

## 6. Replay protection is bounded, and therefore incomplete

**Open — revisit at Gate D.** Each agent remembers its last
`MAX_IDEMPOTENCY_RECORDS` (32) idempotency keys. A key reused after more than 32
subsequent requests is not recognised as a duplicate and would create a second
request.

An unbounded set would be exact but grows without limit, and the storage is paid
for by the contract account. 32 covers the realistic retry window — a client
retrying a failed call does so within seconds, not after 32 unrelated payments.
The gap is real and is recorded here rather than described as full replay
protection. Note what it is *not*: it is not a way to exceed a spending cap,
because every accepted request is still evaluated against the budget and still
reserves from it. The damage from a missed duplicate is a second payment within
policy, not an over-limit one.

## 7. Revoking an agent destroys its spend ledger

**Settled, with a noted consequence.** `revoke_agent` removes the agent record,
including its rolling spend history. Re-registering the same key starts with a
fresh 24-hour budget.

This is an owner capability, not a bypass: only the owner can revoke, and an
owner who wants a higher cap can simply raise it. It is recorded because it
looks like a budget reset if encountered without context.

## 8. Fee caps on Bitcoin depend on untrusted UTXO data

**Open — must be resolved before Gate E.** Invariant 9 requires fee limits to
be checked against the fee the signed transaction actually pays. On an EVM chain
the fee is an explicit field the contract validates. A Bitcoin fee is
`sum(inputs) - sum(outputs)`, and input values come from UTXO data supplied by
the semi-trusted SDK/relayer, which §4 of the project contract says not to
trust.

The contract therefore cannot independently verify a Bitcoin fee. A relayer that
reports inflated input values could cause a transaction that pays more to miners
than the fee cap intends. What it cannot do is redirect the payment or raise the
amount to the recipient, because outputs are constructed by the contract from
policy-approved fields — so invariant 15 still holds and the loss is bounded by
the UTXO set the Keyring address actually controls.

This is a residual risk, not a solved problem. It is tracked in
`docs/threat-model.md` and must be stated plainly in the README before any
Bitcoin claim is made.

## 9. Toolchain pin: the `cargo near new` template cannot build itself

**Settled.** The repository pins Rust `1.99` and `cargo-near` `0.23.0`.

`cargo near new` (cargo-near 0.19.0) generates `rust-toolchain.toml` pinned to
`1.86` together with `near-sdk = "5.23"`, which resolves to 5.30.1 and declares
`rust-version = 1.95`. The generated project therefore fails to compile as
emitted; this was reproduced directly, not inferred. Compounding it,
`cargo-near-build` 0.11.0 refuses to build wasm produced by rustc ≥ 1.87
("not compatible with nearcore VM"), which makes near-sdk 5.30.1 and cargo-near
0.19.0 a mutually exclusive pair.

Upgrading cargo-near to 0.23.0 (cargo-near-build 0.11.5) lifts the rustc ceiling
and the contract builds. Anyone reproducing this repo needs cargo-near ≥ 0.23.0;
0.19.0 will fail with a misleading "downgrade to 1.86" message.

## 10. NEP-330 reproducible-build metadata is absent on purpose

**Open — restore at Gate C.** `cargo near new` emits a `reproducible_build`
block pinning `sourcescan/cargo-near:0.18.0-rust-1.86.0` with its digest. That
image ships rustc 1.86 and cannot build near-sdk 5.30.1, so the block is
removed rather than left in place to fail.

Restoring it requires a sourcescan image with rustc ≥ 1.95 **and** its real
sha256 digest read from the registry. A digest must never be guessed: a wrong
one either fails the build or, worse, pins an unintended image. Until then the
contract is verifiably built from source but not reproducibly built.

## 11. The MCP tool surface excludes every privileged action

**Settled.** The server exposes exactly `get_addresses`, `get_policy`,
`simulate_transfer`, `request_transfer`, `get_history`.

There is no tool to register an agent, change a policy, enable an agent or sign
arbitrary data. The agent runtime is assumed to be under adversarial control, so
a tool it cannot call is the only kind it cannot be tricked into calling. A test
asserts the exposed set, so widening it is a deliberate, reviewable change.

## 12. Amounts cross every boundary as decimal strings

**Settled.** `u128` in Rust, `U128` (JSON string) on the wire, `string` in
TypeScript. The MCP validator rejects a JSON *number* for an amount instead of
coercing it.

`1e18` wei does not survive a round trip through an IEEE-754 double. Accepting a
number and converting would silently alter a payment amount, which is the exact
failure the integer-base-units rule exists to prevent.

## 13. Signing is not implemented, and the deployment says so

**Settled for Gate A.** `SignerBackend::Mock` is the only working backend, and
`is_mock_signer()` is a public view.

Exposing it means no dashboard, demo or report can present mock output as a real
MPC signature without the deployment contradicting it. The real signer interface
is written at Gate C against the deployed testnet signer contract, not from
memory.
