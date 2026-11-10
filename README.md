# Keyring

**Policy-enforced wallet infrastructure for AI agents.**

Keyring lets an owner give an AI agent bounded authority to spend, without giving
it control of a private key. A NEAR smart contract holds the spending policy and
decides every request. Only a request that passes policy may proceed to signing
via NEAR Chain Signatures (MPC).

> An AI agent can have financial autonomy without having unrestricted financial
> authority.

---

## Status: Gate C of F

This is early, honest-about-itself infrastructure. What exists today:

| | |
|---|---|
| ✅ **Policy engine** | All seven MVP rules, 30 boundary tests |
| ✅ **Access control** | Owner-only mutation, key-based agent identity, 28 tests |
| ✅ **Real MPC signing** | Deployed to NEAR testnet; a real signature from `v1.signer-prod.testnet`, independently verified |
| ✅ **Signing lifecycle** | `Created → Signing → Signed \| Failed`, private callback, 14 tests |
| ✅ **Typed SDK + MCP surface** | 15 TypeScript tests |
| ⬜ **EVM / Bitcoin transactions** | **Not implemented.** Gate C signs a domain-separated commitment to the approved fields, *not* a broadcastable transaction. |
| ⬜ **Broadcast to any chain** | Not implemented. |

**Nothing here has been audited or used to move value of any kind.** 87 tests
pass, and real signing is verified on testnet — but no Ethereum or Bitcoin
transaction has yet been constructed, so Keyring cannot currently make a
payment on any chain. That is Gate D.

A mock signature is never presented as a real one: `StoredSignature.mock` is
persisted on every request, so the distinction survives into any dashboard,
indexer or transcript that reads it.

See `docs/development.md` for the full gate table.

### Verify it yourself

```bash
node scripts/verify-signature.mjs keyring-gatec-1794295861.testnet 1 testnet
```

This shares no code with the contract. It recomputes the signed payload from the
policy-approved fields, fetches the derived key from the MPC signer, verifies
the ECDSA signature, and recovers the public key from the signature to confirm
it is the same key — 8 checks, all independent of the contract's own claims.

## How it works

```
AI agent runtime (untrusted — assume prompt injection)
        │
        ▼
MCP server / TypeScript SDK (semi-trusted — no authority)
        │  (chain, destination, amount, fee)
        ▼
NEAR Keyring contract  ◄── the policy enforcement boundary
        │
        ▼
NEAR Chain Signatures MPC      ✅ verified on testnet
        │
        ▼
Relayer → Base Sepolia / Bitcoin testnet4   [Gate D / E]
```

Everything above the contract is assumed hostile or unreliable. The design
property that matters: **none of it can increase authorised spend or redirect a
payment.** An agent's request carries four validated fields and nothing else —
no calldata, no transaction preimage, no output list, no raw hash, no derivation
path. The contract builds the transaction itself from values policy approved.

## Policy rules

Per agent, per chain, in integer base units (wei / satoshi — never floating
point):

- **Enabled / disabled** — the owner's kill switch
- **Chain allowlist** — the absence of a chain policy is the denial
- **Destination allowlist** — an empty list permits nobody, never anybody
- **Per-request cap**
- **Rolling 24-hour cap** — reserved at authorisation, checked against the
  projected total
- **Time window** — UTC minutes of day, including windows that wrap midnight
- **Fee cap**

Evaluation order is fixed, so a request breaking several rules always reports the
same one. Refusals are structured — code, rule, human-readable message,
configured limit, observed value:

```json
{
  "outcome": "refused",
  "request_id": 7,
  "refusal": {
    "code": "daily_cap_exceeded",
    "rule": "rolling_24h_cap",
    "message": "this transfer would bring 24h spend to 2000000000000000001 wei, over the cap of 2000000000000000000 wei (2000000000000000000 already committed)",
    "limit": "2000000000000000000",
    "observed": "2000000000000000001"
  }
}
```

The refusal is part of the product, not an error to hide.

## Quick start

Requires Rust 1.99, `cargo-near` **≥ 0.23.0** (0.19.0 cannot build this — see
`docs/security-decisions.md` §9), Node ≥ 22 and pnpm.

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked cargo-near --version 0.23.0
pnpm install

cargo test --workspace     # 58 contract tests
pnpm -r test               # 15 TypeScript tests

cd contracts/keyring && cargo near build non-reproducible-wasm
```

`cargo build` at the workspace root fails by design — `near-sdk` requires the
wasm target. Use `cargo check --target wasm32-unknown-unknown`.

## Contract interface

**Owner only** — authority derived from `predecessor_account_id()`, never a
parameter:

| Method | |
|---|---|
| `register_keyring()` | Caller becomes an owner |
| `register_agent(public_key, label, policy)` | Register an agent key |
| `set_policy(public_key, policy)` | Replace a policy |
| `set_agent_enabled(public_key, enabled)` | Kill switch |
| `revoke_agent(public_key)` | Remove an agent |

**Agent** — identity from `env::signer_account_pk()`, never a parameter:

| Method | |
|---|---|
| `request_transfer(chain, destination, amount, fee, idempotency_key)` | Returns `Signed`, `Refused`, `Duplicate` or `SigningFailed` |
| `on_signed(...)` | Private callback. Rejects any predecessor but the contract itself. |

Attach about 300 TGas to `request_transfer`: the contract forwards 100 TGas to
the signer and reserves 20 TGas for its callback. The 1 yoctoNEAR signer deposit
is attached by the contract from its own balance, so `request_transfer` is not
payable and an agent cannot influence it.

**Views** — no mutation, no budget consumed:

`simulate_transfer`, `get_keyring`, `get_agent`, `get_policy`, `get_request`,
`get_history`, `get_derivation_path`, `get_signer_backend`, `is_mock_signer`.

## MCP tools

Exactly five, and the omissions are deliberate: there is no tool to register an
agent, change a policy, enable an agent or sign arbitrary data. A tool the agent
runtime cannot call is the only kind it cannot be tricked into calling. A test
asserts the exposed set.

`get_addresses` · `get_policy` · `simulate_transfer` · `request_transfer` ·
`get_history`

## Known limitations

Read `docs/threat-model.md` for the full list. The ones that matter most:

1. **A compromised agent key can still spend the remaining 24-hour budget** to an
   allowlisted destination. Keyring bounds blast radius; it does not eliminate it.
2. **Bitcoin fee caps would rest on UTXO data the contract cannot verify.** Open
   issue, must be resolved before any Bitcoin claim (`security-decisions.md` §8).
3. **Replay protection is bounded** at 32 idempotency keys per agent. The uncaught
   case is a second within-policy payment, never an over-limit one.
4. **A failed broadcast still consumes budget** until the window rolls. Deliberate:
   refunding on a relayer's report would let a hostile relayer mint spend capacity.
5. **Transaction-construction invariants are not yet proven by tests** — only by
   the absence of dangerous parameters. Gate D/E must close this.
6. **A failed signing keeps its budget reservation.** The contract cannot prove
   the MPC network never assembled a signature, so releasing budget could
   authorise the same spend twice. A failed signing therefore consumes budget
   until the window rolls.
7. **The MPC wire types are mirrored, not imported.** The official
   `near-mpc-sdk` 0.0.1 does not compile against near-sdk 5.30.1. The schemas
   were read from the deployed signer's own ABI and are pinned by tests, but
   must be re-checked when the signer is upgraded.

## Documentation

| | |
|---|---|
| `docs/architecture.md` | Components, request flow, state layout, events |
| `docs/threat-model.md` | Assets, boundaries, 14 threats, residual risks |
| `docs/security-decisions.md` | 13 decisions with reasoning |
| `docs/development.md` | Setup, verified commands, gate status |
| `CLAUDE.md` | The project contract governing this repository |

## License

MIT. See `LICENSE`.
