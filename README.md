# Keyring

**Policy-enforced wallet infrastructure for AI agents.**

Keyring lets an owner give an AI agent bounded authority to spend, without giving
it control of a private key. A NEAR smart contract holds the spending policy and
decides every request. Only a request that passes policy may proceed to signing
via NEAR Chain Signatures (MPC).

> An AI agent can have financial autonomy without having unrestricted financial
> authority.

---

## Status: Gate F — the full agent workflow runs end to end

This is early, honest-about-itself infrastructure. What exists today:

| | |
|---|---|
| ✅ **Policy engine** | All seven MVP rules, 30 boundary tests |
| ✅ **Access control** | Owner-only mutation, key-based agent identity, 28 tests |
| ✅ **Real MPC signing** | Deployed to NEAR testnet; a real signature from `v1.signer-prod.testnet`, independently verified |
| ✅ **Signing lifecycle** | `Created → Signing → Signed \| Failed`, private callback, 14 tests |
| ✅ **EIP-1559 construction** | Built in-contract, matches **viem** byte for byte across 5 fixtures |
| ✅ **Signature → address** | The MPC signature recovers to the derived Keyring address |
| ✅ **Typed SDK + MCP surface** | 28 TypeScript tests |
| ✅ **Payment on Base Sepolia** | [Included in block 56892318](https://sepolia.basescan.org/tx/0x03f49320c7aa0dcd2126f2a1ab247e0025b1aef8fa23955ab6bfc4d9bce43014), 21000 gas, status success |
| ✅ **Refusals before signing** | Destination, per-request cap and fee cap, each with a structured reason |
| ✅ **MCP server** | 5 tools over stdio, driven against the deployed contract |
| ✅ **Agent demo** | [`evals/transcript.md`](evals/transcript.md) — payment, refusals, revocation, audit trail |
| ✅ **ERC-20 transfers** | Calldata composed in-contract, matches **viem** exactly; signed on testnet |
| ✅ **Bitcoin testnet4** | BIP143 sighash matches **bitcoinjs-lib**; signed on testnet and verified |
| ✅ **Owner-wide budgets** | A keyring-wide cap across all agents, enforced on testnet |
| ⚠️ **Bitcoin broadcast** | The derived address holds no testnet4 BTC, so no Bitcoin transaction has been broadcast. |

**Nothing here has been audited, and nothing has touched mainnet or real
value.** 119 tests pass, and the end-to-end path is real: an agent requested a
payment, the contract checked it against policy, built the EIP-1559 transaction
itself, had it signed by the live NEAR MPC network, and the transaction was
included in a Base Sepolia block. Disallowed requests are refused before any
signature is requested.

What that payment proves, and what it does not: Keyring moved testnet ETH under
policy. It has not been audited, Bitcoin is unimplemented, and ERC-20 transfers
are absent by design (the transaction has no calldata field at all).

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
- **Asset allowlist** — per chain. Permission to move a token is not permission
  to send native value, or the reverse, and each asset has its own destination
  allowlist
- **Per-request cap** — per asset, since amounts are in the asset's own base
  units
- **Rolling 24-hour cap** — per asset; reserved at authorisation, checked
  against the projected total
- **Owner-wide 24-hour cap** *(optional)* — bounds the total across **every**
  agent in the keyring, which per-agent caps cannot do: an owner running N
  agents each capped at C is otherwise exposed to N x C
- **Time window** — UTC minutes of day, including windows that wrap midnight
- **Fee cap** — checked against `gas_limit * max_fee_per_gas`, which the
  contract derives. There is no caller-supplied fee field.

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
| `set_aggregate_budget(budget)` | Keyring-wide 24h caps across all agents |
| `set_agent_btc_pubkey(public_key, compressed_hex)` | Register the agent's Bitcoin key so the contract can build change outputs |

**Agent** — identity from `env::signer_account_pk()`, never a parameter:

| Method | |
|---|---|
| `request_transfer(chain, asset, destination, amount, params, idempotency_key)` | Returns `Signed`, `Refused`, `Duplicate` or `SigningFailed` |
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
agent, change a policy, enable an agent, revoke an agent or sign arbitrary data.
A tool the agent runtime cannot call is the only kind it cannot be tricked into
calling. A test asserts the exposed set, so widening it is a visible change.

| Tool | |
|---|---|
| `get_addresses` | Derivation path and the derived address Keyring pays from |
| `get_policy` | Caps, allowlists, time window, enabled state |
| `simulate_transfer` | Would this be allowed, and if not which rule refuses it |
| `request_transfer` | Request a payment within policy |
| `get_history` | Past requests with the reason for every refusal |

Four are read-only. `request_transfer` is registered **only** when an agent key
is configured, so a read-only deployment does not advertise a spending tool at
all.

### Running it

```bash
pnpm install && pnpm -r build

export KEYRING_CONTRACT_ID=keyring-gated-1794298589.testnet
export KEYRING_OWNER_ID=$KEYRING_CONTRACT_ID
export AGENT_ACCOUNT_ID=<agent account>   # omit to run read-only
export AGENT_PRIVATE_KEY=<agent key>
node packages/mcp-server/dist/bin.js
```

Add it to an MCP client with:

```json
{
  "mcpServers": {
    "keyring": {
      "command": "node",
      "args": ["/absolute/path/to/keyring/packages/mcp-server/dist/bin.js"],
      "env": {
        "KEYRING_CONTRACT_ID": "keyring-gated-1794298589.testnet",
        "AGENT_ACCOUNT_ID": "...",
        "AGENT_PRIVATE_KEY": "..."
      }
    }
  }
}
```

## The demo

[`evals/transcript.md`](evals/transcript.md) is a real run: an agent discovers
its limits, simulates, makes a payment that lands on Base Sepolia, is refused
three different ways, gets revoked by its owner, and then cannot transact.

```bash
node scripts/demo-agent.mjs      # regenerates the transcript
```

The step worth looking at is the revocation. It happens through the SDK with the
owner's key, because there is no MCP tool for it — the agent cannot revoke
itself, re-enable itself or change its own caps, since no such tool exists for
it to be manipulated into calling.

## Chains and assets

| | |
|---|---|
| Base Sepolia — native ETH | Built, verified against viem, **payment landed on chain** |
| Base Sepolia — ERC-20 | Built, verified against viem, signed on testnet |
| Bitcoin testnet4 — P2WPKH | Built, verified against bitcoinjs-lib, signed on testnet |

Bitcoin is one input, native segwit, one payment plus change to the Keyring's
own address. Multiple inputs are not supported rather than half-supported.
Bech32m (Taproot) addresses are refused, since Keyring cannot construct those
spends.

The Bitcoin address for the reference deployment is
`tb1qthnksfdpen20ka34h9dhapdgttwxcdr4z4nhgm`. Funding it is all that
stands between the verified signature and a broadcast spend.

## Known limitations

Read `docs/threat-model.md` for the full list. The ones that matter most:

1. **A compromised agent key can still spend the remaining 24-hour budget** to an
   allowlisted destination. Keyring bounds blast radius; it does not eliminate it.
2. **Owner-wide budgets are opt-in.** Per-agent caps bound one agent. Unless
   the owner sets a keyring-wide cap, N agents each capped at C still expose
   the owner to N x C — a policy reading "2 ETH per 24h" limits that *agent*.
   `set_aggregate_budget` bounds the total; nothing sets it by default.
3. **No Bitcoin or ERC-20 transaction has been broadcast.** Both are
   constructed, signed by the real MPC network and verified against independent
   references, but the derived addresses hold no testnet4 BTC and no test
   tokens. The fee-cap concern that originally blocked Bitcoin is resolved:
   BIP143 commits the input amount, so a relayer that misreports it produces an
   unusable signature (`security-decisions.md` §23).
4. **Replay protection is bounded** at 32 idempotency keys per agent. The uncaught
   case is a second within-policy payment, never an over-limit one.
5. **A failed broadcast still consumes budget** until the window rolls. Deliberate:
   refunding on a relayer's report would let a hostile relayer mint spend capacity.
6. **Transaction-construction invariants are not yet proven by tests** — only by
   the absence of dangerous parameters. Gate D/E must close this.
7. **A failed signing keeps its budget reservation.** The contract cannot prove
   the MPC network never assembled a signature, so releasing budget could
   authorise the same spend twice. A failed signing therefore consumes budget
   until the window rolls.
8. **The MPC wire types are mirrored, not imported.** The official
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
