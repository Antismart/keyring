# CLAUDE.md — Keyring

Primary operating instructions for Claude Code and any coding agents working in
this repository. Treat this file as the project contract. Read it before making
changes.

## 1. Mission

Build Keyring: open-source, policy-enforced wallet infrastructure for AI agents.

Keyring lets an owner give an AI agent bounded authority to request blockchain
transactions without giving the agent unrestricted control of private keys.

A NEAR smart contract stores and enforces spending policies. Only after a request
passes those policies may the contract invoke NEAR Chain Signatures (MPC) to
produce a signature for a supported external chain.

**Product principle:** an AI agent can have financial autonomy without having
unrestricted financial authority.

Keyring **is**:
- Developer infrastructure, not a consumer wallet.
- Runtime-agnostic; it should work with different agent frameworks.
- Policy enforcement plus wallet/signing infrastructure.
- Open and inspectable, with policy decisions and relevant events recorded on NEAR.

Keyring is **not**:
- An agent framework.
- A custodian of user funds or fiat.
- A token project.
- A general-purpose arbitrary-hash signing service.
- A dashboard-first product.

## 2. How to work

You are an autonomous engineering agent. Own implementation tasks end to end, but
do not silently make high-impact security or product decisions.

### Required workflow

1. Inspect the repository, current branch, existing code, tests, and this file
   before changing anything.
2. Identify the smallest useful implementation slice.
3. Write or update tests alongside implementation.
4. Run formatting, linting, type checks, unit tests, and relevant integration tests.
5. Inspect the diff for security regressions, accidental secrets, unrelated
   changes, and generated files.
6. Update documentation when interfaces, assumptions, commands, or security
   properties change.
7. Report exactly what changed, commands run, test results, known limitations, and
   the next recommended task.

### Agent coordination

If multiple agents are available:
- Delegate independent, well-bounded tasks (for example contract policy tests, SDK
  types, documentation review).
- Assign one owner to each file or module to avoid conflicting edits.
- Have one integrating agent review interfaces and merge the work.
- Do not delegate the same security-critical implementation to multiple agents
  without an explicit comparison/review plan.
- Treat all agent-produced code as untrusted until reviewed and tested.

### Decision rules

- Prefer a small, correct, testable implementation over broad incomplete
  functionality.
- Do not add features merely because a library supports them.
- Do not invent APIs, SDK methods, NEAR protocol behavior, MPC semantics, or chain
  transaction formats. Verify against the installed dependency version and official
  documentation/source.
- If documentation and code disagree, stop and report the discrepancy rather than
  guessing.
- Do not claim a feature works unless a test or reproducible manual verification
  demonstrates it.
- Never hide a failing test, downgrade a security check, or weaken a policy to make
  a demo pass.
- Ask the project owner only when a decision is genuinely blocking, materially
  changes trust/security, or requires credentials/funding/account access. Otherwise
  make a conservative choice and document it.

## 3. Product scope and priorities

The first complete workflow is:

1. Owner registers a Keyring.
2. Owner registers an agent public key and assigns policies.
3. Agent requests a transfer through the SDK or MCP server.
4. Contract identifies the agent and evaluates policy.
5. If allowed, the contract constructs the transaction itself and calls the NEAR
   MPC signer.
6. The signature/result is recorded and returned through the SDK/MCP flow.
7. A request outside policy is refused with a structured reason.
8. Owner can disable/revoke the agent and inspect its history.

### Initial target chains

Priority:
1. Base Sepolia — EVM, secp256k1.
2. Bitcoin testnet4 — Bitcoin transaction signing.

Solana devnet is optional only after Base and Bitcoin are stable, tested, and
demonstrable. Do not start Solana while either priority chain is incomplete.

### MVP policy rules

Implement and test:
- Agent enabled/disabled state (kill switch).
- Chain allowlist.
- Destination allowlist.
- Per-request spending cap.
- Rolling 24-hour spending cap.
- Time window.
- Fee cap.

Use integer base units for all on-chain amounts. Never use floating-point values
for money.

### Explicit non-goals for the initial MVP

Do not implement unless the owner explicitly changes scope:
- TEE/attested runtime enforcement.
- USD-denominated on-chain limits or price-oracle integration.
- Human approval queues.
- NEAR Intents swaps.
- Mainnet deployment or real-value fund handling.
- Token, fees, fiat custody, mobile application.
- More than the two priority chains.

## 4. Architecture and trust boundaries

Target architecture:

```
AI agent runtime (untrusted)
        |
        v
MCP server / TypeScript SDK (semi-trusted)
        |
        v
NEAR Keyring contract (policy enforcement boundary)
        |
        v
NEAR Chain Signatures MPC
        |
        v
Relayer broadcasts signed transaction
        |
        +----> Base Sepolia
        |
        +----> Bitcoin testnet4
```

### Trust assumptions

- **Agent runtime:** untrusted. Assume prompt injection, malicious tool use, and
  agent credential leakage.
- **SDK/MCP/relayer:** semi-trusted. It may submit malformed or stale data and
  cause failed broadcasts, but must not be able to increase authorised spend or
  redirect funds.
- **Keyring contract:** trusted policy enforcement code. Its security is central to
  the product.
- **NEAR MPC:** external trust assumption. Be transparent about threshold
  operators, key derivation, availability, latency, and operational assumptions.
- **Owner account:** root of authority. Compromise of the owner account can change
  policy or revoke agents.
- **Target chains/RPCs:** external dependencies. Do not assume RPC-provided data is
  trustworthy merely because it is returned by a provider.

### Non-negotiable signing boundary

The agent must never be able to call the MPC signer directly.

The contract must be the only authorised predecessor for the derived signing keys
used by Keyring. The agent credential must be scoped to the Keyring contract and
only the required methods. The contract attaches any required MPC deposit itself.

Never expose:
- MPC key shares or private keys.
- Unrestricted signing endpoints.
- A method that signs arbitrary caller-supplied hashes.
- An agent-controlled transaction preimage or arbitrary calldata.

The contract must construct the transaction from validated structured fields. The
caller must not be able to smuggle additional recipients, outputs, calldata, or a
different amount into the signed payload.

## 5. Security invariants

These invariants are release blockers. Add tests that prove them.

1. Only the registered agent key can request actions for that agent.
2. Only the owner can add, remove, enable, disable, or change policies for their
   agents.
3. Disabled or removed agents cannot obtain new signatures.
4. Every signing request is evaluated against all applicable policies before MPC
   invocation.
5. The contract constructs the signed transaction from validated structured fields.
6. The recipient and amount that are signed must match the values approved by policy.
7. EVM token transfer calldata must be composed by the contract from the validated
   token contract, recipient, and amount; do not accept arbitrary calldata.
8. Bitcoin outputs must be constrained to the approved recipient and change back to
   the derived Keyring address. Extra outputs must not be possible.
9. Fee limits must be checked against the actual transaction fee represented by the
   transaction being signed.
10. Concurrent requests must not allow aggregate spending to exceed the rolling
    budget.
11. Budget accounting must be conservative when the contract cannot observe
    destination-chain broadcast/finality.
12. Failed MPC signing must have an explicit, tested state transition and budget
    treatment.
13. A signature returned by MPC but not broadcast must not be treated as a confirmed
    destination-chain payment.
14. Replay, duplicate request, callback, and partial-signing behavior must be
    explicitly handled and tested.
15. A bad or malicious relayer may cause a transaction to fail, but must not be able
    to make Keyring sign a transaction that exceeds policy.
16. All owner-only and private callback methods must enforce caller identity
    correctly.
17. No secret, private key, seed phrase, API token, or funded wallet credential may
    be committed.

If any invariant cannot be implemented or proven within the current design, stop and
document the issue. Do not quietly weaken it.

## 6. Contract design expectations

Use Rust and the NEAR SDK version pinned by the repository. Confirm the current
dependency versions before relying on API details.

The contract should provide clear, typed state and methods for:
- Owner registration.
- Agent registration and removal.
- Policy updates.
- Enable/disable.
- Derived address views.
- Transfer simulation.
- Transfer request.
- Private MPC callback.
- Request status and history views.

Use NEP-297-compatible structured events for:
- Agent added.
- Agent disabled/enabled or removed.
- Policies changed.
- Request refused (include structured rule/reason).
- Request signing started.
- Request signed.
- Request failed.

Avoid unbounded storage growth. Define log pagination and bounded on-contract
history. Events should allow external indexers to reconstruct relevant activity.

### Policy evaluation

Use a deterministic evaluation order and return a structured refusal:
- code or rule identifier.
- Human-readable explanation.
- Configured limit.
- Observed value where applicable.

A simulation/view call must not mutate state or consume budget.

### Budget accounting

Budget reservation must be safe under multiple requests. A request that is
authorised for signing should reserve/debit budget before an asynchronous MPC call
can complete. Define and test exactly when reservations are released.

Because the contract cannot independently observe whether a signed foreign-chain
transaction was broadcast or confirmed, do not automatically refund budget merely
because the relayer reports a broadcast error. Treat unbroadcast signatures as
potentially spendable until a safe reconciliation design exists.

For MPC errors/timeouts, implement an explicit state machine and only release
reservations when the contract can establish that no usable signature was produced.
If this cannot be established, retain the conservative reservation and explain the
limitation.

### Asynchronous signing

Model request lifecycle explicitly, for example:

```
Created -> Refused
Created -> Signing -> Signed
Created -> Signing -> Failed
```

Add request IDs, duplicate protection, callback access control, and handling for
partial signing. Do not assume promise callbacks always succeed.

## 7. Chain-specific implementation rules

### Base Sepolia / EVM

- Use EIP-1559 transaction construction where supported by the selected transaction
  library.
- Validate chain ID, nonce, destination, amount, gas limit, max fee, and priority fee.
- Construct the transaction inside the contract.
- For ERC-20 transfers, construct the standard transfer call from validated fields.
  Do not accept arbitrary calldata.
- Ensure the signed transaction hash/preimage matches an independently computed
  reference using viem.
- Test signature recovery and the derived address.
- Treat nonce freshness and broadcast as relayer/RPC concerns, but do not allow them
  to alter the authorised recipient or value.

### Bitcoin testnet4

- Start with the simplest supported spend type and one input if that is what can be
  verified safely.
- Validate UTXO data and transaction construction assumptions.
- Construct sighashes in the contract using the selected, pinned transaction library.
- Ensure outputs are exactly the approved payment and change to the derived Keyring
  address.
- Enforce fee caps.
- Cross-check sighash/preimage calculations against an independent bitcoinjs-lib
  fixture.
- Handle multiple inputs and partial signing explicitly. Do not claim multi-input
  support until it is tested end to end.

### Solana

Do not implement until both priority chains pass their integration gates. If added
later, use a separately reviewed design for Ed25519 message construction and
destination/value validation.

## 8. SDK and MCP expectations

### TypeScript SDK

The SDK should provide a small, typed surface, including equivalents of:
- `getAddresses`
- `getPolicy`
- `simulateTransfer`
- `requestTransfer`
- `getRequest`
- `getHistory`
- `disableAgent` / `revokeAgent`

Exact naming may follow repository conventions, but keep the API consistent and
documented.

The SDK may:
- Derive addresses using verified NEAR Chain Signatures tooling.
- Fetch UTXOs, nonces, fees, and required chain data.
- Submit structured requests.
- Assemble/broadcast transactions after signing.
- Return structured success, refusal, pending, and failure results.

The SDK must not become a security authority. The contract remains authoritative.

### MCP server

Expose narrowly scoped tools, such as:
- `get_addresses`
- `get_policy`
- `simulate_transfer`
- `request_transfer`
- `get_history`

Validate all tool inputs with schemas. Return structured errors. Never expose
arbitrary signing or policy mutation tools to the agent unless explicitly designed
and authorised.

The MCP server should make the safe path easy, but must not be relied upon for
enforcement.

## 9. Dashboard expectations

Build the owner dashboard only after contract interfaces and SDK flows are stable.

Minimum screens:
- Connect owner account.
- Create/register Keyring.
- Register agent.
- Configure policies.
- View derived addresses.
- View request history and refusal reasons.
- Disable/revoke agent.

The dashboard is a convenience layer. All privileged actions must be enforced by the
contract. A CLI/SDK must remain sufficient to operate the system if the dashboard is
unavailable.

Do not spend time on elaborate visual effects or marketing pages before the
end-to-end workflow works.

## 10. Testing requirements

### Contract unit tests

Test every policy rule on both sides of its boundary:
- Exactly at cap.
- One base unit above cap.
- Daily cap reached across multiple requests.
- Rolling-window expiry.
- Allowed and disallowed destinations.
- Allowed and disallowed chains.
- Time-window boundaries, including overnight windows if supported.
- Fee cap boundary.
- Disabled and removed agent.
- Non-owner mutation attempts.
- Unregistered signer key.
- Duplicate request IDs.
- Concurrent requests.
- Callback from wrong predecessor.
- MPC success, timeout, failure, and partial signing.

### Transaction construction tests

- EVM native transfer hash matches viem.
- EVM token transfer calldata is exact and cannot be overridden by caller.
- Bitcoin sighash matches an independent fixture.
- Bitcoin outputs cannot be extended or redirected.
- Change returns to the derived Keyring address.
- Fee calculation and fee-cap enforcement are correct.

### Integration tests

- Deploy contract to NEAR testnet.
- Exercise the testnet MPC signer.
- Complete an allowed Base Sepolia transfer.
- Demonstrate a policy refusal.
- Exercise agent disable/revocation.
- Complete a Bitcoin testnet4 spend if safely implemented.
- Verify destination-chain transaction and NEAR audit events.

Use a mock signer for deterministic local tests, but never present mock-signer
results as proof of real MPC integration.

### CI

CI should run:
- Rust formatting and linting.
- Rust unit tests.
- Contract build.
- TypeScript formatting/linting/type checking.
- SDK and MCP tests.
- Dashboard build.
- Security-sensitive integration tests where credentials and network access are
  configured.

Never make CI green by skipping or weakening failing tests without documenting the
reason and obtaining owner approval.

## 11. Documentation and repository hygiene

Maintain:
- `README.md` — what Keyring does, architecture, setup, testing, demo.
- `docs/architecture.md` — components and data flows.
- `docs/threat-model.md` — assets, trust boundaries, threats, mitigations, residual
  risks.
- `docs/security-decisions.md` — important security decisions and rationale.
- `docs/development.md` — local setup and commands.
- `evals/` — reproducible MCP/agent demo transcript.
- `.env.example` — variable names only, no real secrets.

Use MIT or Apache-2.0 unless the owner specifies otherwise.

Document limitations honestly. Distinguish:
- Unit-tested behavior.
- Mocked behavior.
- Testnet-verified behavior.
- Mainnet-verified behavior.

Do not claim an audit, formal verification, production readiness, or security
guarantee that has not occurred.

## 12. Delivery gates

Do not advance simply because code has been written. Advance when the gate is met.

**Gate A — Repository and contract foundation**
- Monorepo builds.
- CI is green.
- Contract state and public interfaces are documented.
- Mock signer is available for tests.

**Gate B — Policy correctness**
- All policy tests pass.
- Owner and agent access control tests pass.
- Concurrent budget tests pass.
- Refusal responses are structured and deterministic.

**Gate C — Real NEAR signing**
- Contract successfully calls the testnet MPC signer.
- Callback lifecycle is tested.
- Signature is independently verified.
- No direct agent-to-MPC path exists.

**Gate D — Base Sepolia end to end**
- An allowed transfer is signed and broadcast.
- Destination-chain result is verified.
- A disallowed transfer is refused before signing.
- Audit events are visible.

**Gate E — Bitcoin end to end**
- Supported spend type is constructed and signed correctly.
- Independent sighash fixture matches.
- Outputs and fee cap are enforced.
- Testnet transaction is verified.

**Gate F — Agent workflow and submission**
- SDK and MCP tools work against deployed testnet contract.
- Agent demo shows allowed payment, refusal, and revocation.
- README, threat model, and demo are complete.
- Public repository and submission materials are ready.

If time is constrained, preserve the security core and one fully working chain
rather than faking a second chain.

## 13. Hackathon context

The current target is the NEAR $250K Hackathon.

- Primary track: **AI Security & Defense**.
- Secondary positioning: Agent Economy and Autonomous Business.
- The project plan records a **November 14, 2026, 23:59 UTC** submission deadline.
  Verify the live official deadline before submission.
- Expected submission materials include public repository, README, demo video/public
  post, and the submission form.

The demo should show one coherent workflow:
1. Owner creates a Keyring and registers an agent with limits.
2. Agent makes an allowed payment.
3. Agent attempts a disallowed payment and receives a precise refusal.
4. Owner disables/revokes the agent.
5. Audit history shows the decisions.

The refusal is part of the product, not an error to hide.

## 14. Environment and secrets

- Keep all credentials in local environment variables or an approved secret manager.
- Commit only `.env.example`.
- Never request or print private keys, seed phrases, recovery phrases, or production
  wallet credentials.
- Use testnet accounts and valueless/test assets for development.
- Do not deploy to mainnet or handle real user funds without explicit owner approval
  and a security review.
- If a required credential is missing, implement against a mock/interface where
  possible and report the exact variable name needed. Never invent credentials.

## 15. Final response format after each task

At the end of every implementation task, report:

**Completed**
- Files/modules changed.
- Behavior implemented.

**Verification**
- Exact commands executed.
- Tests passed/failed.
- Whether verification used mocks, sandbox, or a real testnet.

**Security notes**
- Invariants covered.
- Remaining risks or unverified assumptions.

**Next step**
- The single highest-priority next task.

Be concise but specific. Do not say "everything is done" when only scaffolding or
partial implementation exists.
