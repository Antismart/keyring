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

## 14. MPC wire types are mirrored, not imported

**Settled.** `contracts/keyring/src/mpc.rs` defines the signer's request and
response types locally instead of depending on `near-mpc-sdk`.

The official crates exist only at version 0.0.1, and their transitive dependency
`near-mpc-crypto-types` 0.0.1 does not compile against near-sdk 5.30.1:
near-sdk added `CurveType::MLDSA65` and the crate has a non-exhaustive match
over it. No newer release exists.

Because the boundary is JSON, mirroring the verified schema is sufficient, and
for a security-sensitive contract a smaller dependency surface is preferable.
The schemas were not written from memory or from documentation — they were read
from the deployed signer's own embedded ABI, obtained by calling its
`__contract_abi` export over RPC and zstd-decompressing the result:

- account `v1.signer-prod.testnet`, contract version `3.18.0`
- source `github.com/near/mpc` @ `e691bdb98d68dcf74653da58d043453a6318765f`

One detail that a from-memory implementation would have got wrong: the payload
field serialises as **`payload_v2`**, not `payload`. The signer still accepts
`payload`, but interprets it as a deprecated raw `[u8; 32]` array rather than
a hex string, so sending the old name would have failed confusingly.

**The trade-off:** these definitions must be re-checked against the signer's ABI
whenever it is upgraded. `contracts/keyring/tests/mpc_lifecycle.rs` pins the
exact request and response JSON, so a schema change fails a test rather than
silently producing a request the signer misreads.

## 15. Gate C signs a contract-derived commitment, not a transaction

**Open — replaced at Gate D.** `signer::gate_c_commitment` hashes the
policy-approved fields into the 32 bytes sent to the MPC signer. It is not an
Ethereum or Bitcoin transaction.

This exists so the MPC round trip, callback lifecycle and signature
verification could be proven before transaction construction was written. Two
properties keep it safe:

1. **Contract-derived.** Every input comes from validated contract state. No
   caller supplies or influences the bytes, so this is not a method that signs
   an arbitrary caller-supplied hash.
2. **Not replayable.** The `keyring-v1:gate-c-commitment:` domain separator
   means the preimage cannot coincide with an Ethereum RLP transaction hash or a
   Bitcoin sighash, so the signature is worthless as a payment anywhere.

Gate D replaces the function body with the real EIP-1559 transaction hash, built
from the same validated fields.

## 16. A failed signing retains its budget reservation

**Settled.** `on_signed` moves the request to `Failed` and leaves the
reservation in place.

A locally observed promise failure or yield timeout does not prove the MPC
network never assembled a signature; `respond` may have succeeded on the node
side. Releasing the budget on that evidence could authorise the same spend
twice. CLAUDE.md §6 requires the conservative reservation when the contract
cannot establish that no usable signature exists, which is exactly this case.

**The consequence,** stated plainly: a genuinely failed signing consumes budget
until the 24-hour window rolls. That is an availability cost accepted to protect
spending integrity.

## 17. Mock signatures are flagged in stored data, not just by deployment

**Settled.** `StoredSignature.mock` is persisted on the request alongside the
signature itself, in addition to the `is_mock_signer()` view.

A deployment-level flag can be read separately from the data and lost in
transit to a dashboard, an indexer or a demo transcript. Storing the flag on the
record makes a mock signature and a real one distinguishable at the data level,
permanently, wherever the record is read.

## 18. Gate C was verified on testnet, and the record is reproducible

**Settled.** The contract was deployed and exercised against the live signer:

- Keyring contract: `keyring-gatec-1794295861.testnet`
- Signer: `v1.signer-prod.testnet`, domain 0 (CaitSith, purpose Sign, secp256k1)
- Request 1: allowed, real signature, `mock: false`
- Request 2: refused with `destination_not_allowed`, no MPC call made

`scripts/verify-signature.mjs` re-verifies any request from chain data alone,
sharing no code with the contract. It recomputes the payload, fetches the
derived key from the signer, verifies the ECDSA signature and recovers the
public key from the signature to confirm it is the same key.

The agent-to-MPC boundary was checked empirically rather than assumed. Asking
the signer for the same path with `predecessor` set to the agent account
returns a **different** key from the one bound to the Keyring contract, because
the signer derives every key from its own caller. An agent calling the signer
directly therefore cannot reach a Keyring key.

## 19. Budgets are per agent and per chain, not per owner

**Settled for the MVP.** The rolling 24-hour ledger lives on `Agent.ledgers`,
keyed by chain, and `evaluate` is handed one agent's entries for one chain and
nothing else. There is no owner-wide or keyring-wide aggregate budget.

**What follows from that:** an owner running N agents, each capped at C per 24
hours on a chain, is exposed to **N x C** on that chain in a day. The cap bounds
an *agent*, not a *keyring*. For a single-agent keyring the two are identical,
which is exactly why the distinction is easy to miss when reading a policy that
says "2 ETH per 24h".

This is the right default for the MVP rather than an oversight. Per-agent
budgets are what make an agent's authority independently reasoned about,
independently revocable, and independently auditable. A shared pool introduces
coupling: one busy agent could exhaust the allowance of an unrelated one, and a
refusal would then depend on the behaviour of an agent the caller knows nothing
about, which makes refusals much harder to explain.

It is, however, a genuine capability gap for an owner who wants a ceiling on
total programme spend rather than per-agent spend. Recorded here so the limit is
stated rather than assumed, and pinned by
`each_agent_has_its_own_budget_and_there_is_no_owner_wide_cap` in the access
control suite, which must fail if an aggregate budget is ever introduced.

### If an owner-wide budget is added later

Three parts of the current design need attention:

1. **`evaluate` stops being a pure function of one agent's state.** It would
   need the owner's other ledgers too. The signature already takes spend entries
   as a parameter, so the shape survives, but the caller must assemble more and
   the evaluation order needs a defined position for the new rule — almost
   certainly after the per-agent cap, so the narrower limit still reports first.
2. **Bounded storage gets harder.** `MAX_SPEND_ENTRIES` is 64 per agent per
   chain, so an owner-wide scan across 16 agents could touch 1024 entries on
   every request. A rolled-up per-owner counter, maintained on reserve and
   pruned on a schedule, is the workable shape; scanning is not.
3. **Decision 7 becomes load-bearing.** Revoking an agent currently destroys its
   ledger. With an owner-wide budget that must *not* reduce the owner-level
   total, or revoke-and-re-register becomes a budget reset for the whole
   keyring rather than just for one agent.

Concurrency is not a concern: NEAR executes calls to one contract account
sequentially, so an owner-level counter would be as race-free as the per-agent
ledger is today (threat T4).

## 20. The fee is derived from gas parameters, never supplied by the caller

**Settled, and it fixes an unsound earlier design.** Up to Gate C,
`request_transfer` took a `fee` argument that policy checked against the fee
cap. That was wrong in a way worth stating plainly: the number policy checked
and the number the transaction could actually spend were two different values,
and the caller controlled both.

An EIP-1559 transaction's maximum cost is `gas_limit * max_fee_per_gas`. A
caller could have declared `fee: 1` to pass the cap while supplying gas
parameters authorising far more, and the contract would have signed it.

The `fee` parameter is gone. The caller now supplies only the gas parameters
that must go into the transaction anyway, and the contract computes
`EvmParams::max_fee_wei()` from exactly those numbers. The value policy checks
and the value the signed transaction can spend are now the same number by
construction, which is what invariant 9 actually asks for.

The ceiling, not the expected cost, is what gets checked. Actual cost is
`gas_used * effective_gas_price`, which is never higher, so a signed
transaction can never cost more than the cap permitted regardless of network
conditions.

Gas limits are bounded to `[21000, 200000]`. Keyring builds only plain value
transfers, which cost exactly 21000, so a larger limit cannot buy anything — it
can only raise the fee ceiling. The upper bound is generous rather than pinned
at 21000 so that a caller padding slightly is not refused.

## 21. ERC-20 transfers are not implemented

**Settled for now.** `Eip1559Transfer` has no `data` field. The transaction
encoder always writes empty calldata, so there is no way to attach any.

Invariant 7 requires token transfer calldata to be composed by the contract
from a validated token address, recipient and amount. Rather than implement
that under time pressure and risk getting it subtly wrong, token transfers are
simply absent: the invariant is vacuous because the capability does not exist.
A test asserts the encoded transaction ends with empty data and an empty access
list, so adding calldata would be a deliberate, visible change.

## 22. Gate D verification

**Complete.** An allowed transfer was built, signed and included in a block on
Base Sepolia, and three kinds of disallowed transfer were refused before any
MPC call.

| | |
|---|---|
| Keyring contract | `keyring-gated-1794298589.testnet` |
| Derived address | `0xbd0748719c9defaff838e0a810a00b0eb563cc53` |
| Transaction | `0x03f49320c7aa0dcd2126f2a1ab247e0025b1aef8fa23955ab6bfc4d9bce43014` |
| Block | 56892318, status success, 21000 gas |

What the chain's own record confirms: `from` is the derived Keyring address,
`to` is the allowlisted destination, `value` is exactly the approved amount,
`chainId` is 84532 and `type` is `0x2`. The contract-built transaction and the
transaction the network executed are the same one.

The fee cap held in practice, which is the point of decision 20. Policy checked
a ceiling of 252,000,021,000 wei (`21000 * 12000001`), and the transaction
actually paid 168,000,000,165 wei. The ceiling bounds the real cost, so a signed
transaction cannot cost more than policy permitted whatever the network does.

Refusals verified on the same deployment, each returned before any signing:

| Request | Code | Limit vs observed |
|---|---|---|
| 2 | `destination_not_allowed` | — |
| 3 | `per_request_cap_exceeded` | 1,000,000,000,000 vs 1,000,000,000,001 |
| 4 | `fee_cap_exceeded` | 100,000,000,000,000 vs 200,000,000,000,000,000 |

Request 4 is decision 20 working on a live deployment. The caller supplied
inflated gas parameters (200000 gas at 1000 gwei); the contract derived the
real ceiling from them and refused. Under the old design the caller would have
declared the fee itself and this would have been signed.
