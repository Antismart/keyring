# Keyring

**Policy-enforced wallet infrastructure for AI agents.**

Keyring lets an owner give an AI agent bounded authority to spend, without
giving it control of a private key. A NEAR smart contract holds the spending
policy, decides every request, and builds the transaction itself. Only a
request that passes policy reaches NEAR Chain Signatures to be signed.

> An AI agent can have financial autonomy without having unrestricted
> financial authority.

Built for the NEAR hackathon, **AI Security & Defense** track.

---

## Verified on three chains

Every transaction below was built inside the contract from policy-approved
fields, signed by the live NEAR MPC network, and confirmed on its chain.

| What | Where | Result |
|---|---|---|
| Native ETH | Base Sepolia | [block 56931717](https://sepolia.basescan.org/tx/0x400f7537303bff49bef9110637ac985b6177ec8e618ab7bf2ac0158f1d37a8ee) — 0.0000005 ETH |
| ERC-20 (USDC) | Base Sepolia | [block 56963072](https://sepolia.basescan.org/tx/0xef8d64d2c6af908d848053822c6a5fee6d106ada406afcf333d6c9933721ea46) — 1 USDC, `Transfer` event emitted |
| Native BTC | Bitcoin testnet4 | [block 160377](https://mempool.space/testnet4/tx/15061f1f6bb2fd892018621bb8523dff7ddef6bf0d672f01b56441eb225aaeee) — 50,000 sat, change returned |

Disallowed requests are refused **before** any signature is requested, with a
machine-readable reason. Contract: `keyring-gated-1794298589.testnet` on NEAR
testnet.

**Nothing here has been audited, and nothing has touched mainnet or real
value.** 192 tests pass. See [What is and is not
verified](#what-is-and-is-not-verified) for the precise boundary.

### Check it yourself

These scripts share no code with the contract. They refetch everything from
chain and re-derive it independently.

```bash
pnpm install && pnpm -r build

# Re-verify a signature end to end. Rebuilds the transaction with viem or
# bitcoinjs-lib, recomputes the signed hash, verifies the signature against the
# MPC-derived key, and recovers that key from the signature.
node scripts/verify-signature.mjs keyring-gated-1794298589.testnet 2   # native ETH
node scripts/verify-signature.mjs keyring-gated-1794298589.testnet 6   # ERC-20
node scripts/verify-signature.mjs keyring-gated-1794298589.testnet 5   # Bitcoin

# Re-generate the reference fixtures and fail on any difference
node scripts/gen-evm-fixtures.mjs --check
node scripts/gen-btc-fixtures.mjs --check
cargo test --test evm_transaction --test bitcoin_transaction
```

## The idea

The agent runtime is assumed hostile — prompt injection, leaked credentials,
malicious tool use. So the agent never holds a key and never says what bytes to
sign. It says only *what it wants to do*:

```
request_transfer(chain, asset, destination, amount, params, idempotency_key)
```

That is the entire attack surface. There is **no** parameter for calldata, a
transaction preimage, an output list, a raw hash, or a derivation path. The
contract evaluates the request against policy and, if it passes, builds the
transaction itself from the values policy approved.

```
AI agent runtime                      untrusted — assume prompt injection
        │
        ▼
MCP server / TypeScript SDK           semi-trusted — holds no authority
        │
        ▼
NEAR Keyring contract                 ◄── the policy enforcement boundary
        │
        ▼
NEAR Chain Signatures (MPC)           keys exist only as threshold shares
        │
        ▼
Relayer → Base Sepolia / Bitcoin testnet4
```

Everything above the contract can cause a transaction to fail. None of it can
increase authorised spend or redirect a payment.

The MPC signer binds every derived key to its own caller, so only this contract
can obtain signatures for Keyring's addresses. That was verified rather than
assumed: asking the signer for the same derivation path with the agent's
account as caller returns a **different** key, controlling nothing.

## Policy

Amounts are integers in each asset's own base units — wei, satoshi, token
units. No floating point anywhere in the contract.

| Rule | |
|---|---|
| **Enabled / disabled** | The owner's kill switch |
| **Chain allowlist** | The absence of a chain policy is the denial |
| **Asset allowlist** | Per chain. Permission to move a token is not permission to send native value, or the reverse |
| **Destination allowlist** | Per asset. An empty list permits nobody, never anybody |
| **Per-request cap** | Per asset |
| **Rolling 24-hour cap** | Per asset, reserved at authorisation |
| **Owner-wide 24-hour cap** | *Optional.* Bounds the total across **every** agent in the keyring |
| **Time window** | UTC minutes of day, including windows that wrap midnight |
| **Fee cap** | Checked against the fee the transaction really pays |

Two of these deserve a note.

**The fee is derived, never declared.** An earlier design let the caller pass a
`fee` that policy checked — unsound, because an EIP-1559 transaction's real
ceiling is `gas_limit × max_fee_per_gas`, which the caller also controlled. The
caller now supplies only the gas numbers that must enter the transaction
anyway, and the contract computes the fee from exactly those. On Bitcoin the
fee is `inputs − outputs`, computed from the same input amount BIP143 binds the
signature to.

**Per-agent caps do not bound a keyring.** An owner running N agents each
capped at C is exposed to N × C. `set_aggregate_budget` caps the total across
all agents; it is opt-in, and nothing sets it by default.

### Refusals are a feature

Evaluation order is fixed, so a request breaking several rules always reports
the same one. Every refusal carries a stable code, the rule, the configured
limit and the observed value:

```json
{
  "outcome": "refused",
  "request_id": 3,
  "refusal": {
    "code": "owner_daily_cap_exceeded",
    "rule": "owner_rolling_24h_cap",
    "message": "this would bring the keyring's total 24h spend to 2000000000000 wei, over the owner-wide cap of 1500000000000 wei (1000000000000 already committed across all agents)",
    "limit": "1500000000000",
    "observed": "2000000000000"
  }
}
```

That one is real output from testnet: a request the agent's own cap allowed,
refused by the keyring-wide cap.

## Chains and assets

| | Construction | Verified against | On chain |
|---|---|---|---|
| Base Sepolia — native | EIP-1559 built in-contract | **viem**, 7 fixtures | ✅ confirmed |
| Base Sepolia — ERC-20 | `transfer` calldata composed in-contract | **viem** | ✅ confirmed |
| Bitcoin testnet4 — P2WPKH | BIP143 sighash built in-contract | **bitcoinjs-lib**, 3 spends + 4 addresses | ✅ confirmed |

The cross-checks target the cases that actually break: RLP's zero encoding (the
empty string, not `0x00`), the `0x7f`/`0x80` boundary, payloads over 55 bytes,
and for Bitcoin the P2WPKH `scriptCode` — which is the P2PKH script over the
same key hash, not the witness program.

**Bitcoin scope:** one input, native segwit, one payment plus change to
Keyring's own address. Multiple inputs are unsupported rather than
half-supported. Bech32m (Taproot) destinations are refused, since Keyring
cannot construct those spends.

**ERC-20 scope:** the contract does not read a token's decimals or balance.
Policy bounds what may be *authorised*, not whether the token will honour it.

## Quick start

Requires Rust 1.99, `cargo-near` **≥ 0.23.0**, Node ≥ 22 and pnpm.

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked cargo-near --version 0.23.0
pnpm install

cargo test --workspace    # 149 contract tests
pnpm -r test              # 43 TypeScript tests

cd contracts/keyring && cargo near build non-reproducible-wasm
```

`cargo-near` 0.19.0 **cannot** build this: it rejects wasm from rustc ≥ 1.87
while `near-sdk` 5.30.1 requires ≥ 1.95. If you see "please downgrade to
1.86.0", your `cargo-near` is too old (`docs/security-decisions.md` §9).

`cargo build` at the workspace root fails by design — `near-sdk` requires the
wasm target. Use `cargo check --target wasm32-unknown-unknown`.

## Contract interface

**Owner only.** Authority comes from `predecessor_account_id()`, never a
parameter, so no caller can act for another account.

| Method | |
|---|---|
| `register_keyring()` | Caller becomes an owner |
| `register_agent(public_key, label, policy)` | Register an agent key |
| `set_policy(public_key, policy)` | Replace a policy |
| `set_aggregate_budget(budget)` | Keyring-wide 24h caps across all agents |
| `set_agent_btc_pubkey(public_key, compressed_hex)` | Register the agent's Bitcoin key, so the contract can build change outputs |
| `set_agent_enabled(public_key, enabled)` | Kill switch |
| `revoke_agent(public_key)` | Remove an agent |

**Agent.** Identity comes from `env::signer_account_pk()` — the key that
actually signed — never a parameter, so an agent cannot act as another.

| Method | |
|---|---|
| `request_transfer(chain, asset, destination, amount, params, idempotency_key)` | Returns `Signed`, `Refused`, `Duplicate` or `SigningFailed` |
| `on_signed(...)` | Private callback; rejects any predecessor but the contract itself |

Attach ~300 TGas to `request_transfer`: 100 TGas is forwarded to the signer and
20 reserved for the callback. The signer's 1 yoctoNEAR deposit is attached by
the contract from its own balance, so the method is not payable and an agent
cannot influence it.

**Views.** No mutation, no budget consumed:

`simulate_transfer`, `get_keyring`, `get_agent`, `get_policy`,
`get_aggregate_budget`, `get_request`, `get_history`, `get_derivation_path`,
`get_signer_backend`, `is_mock_signer`.

`is_mock_signer` exists so no demo can pass mock output off as real. The
distinction is also stored on every request, so it survives into anything that
reads the record.

## MCP server

Five tools, and the omissions are the design. There is no tool to register an
agent, change a policy, enable or revoke one, set the aggregate budget, or sign
arbitrary data. A tool the runtime cannot call is the only kind it cannot be
tricked into calling — and a test asserts the exposed set, so widening it is a
visible change.

| Tool | Read-only |
|---|---|
| `get_addresses` | ✅ |
| `get_policy` | ✅ |
| `simulate_transfer` | ✅ |
| `get_history` | ✅ |
| `request_transfer` | — |

`request_transfer` is registered **only** when an agent key is configured, so a
read-only deployment does not advertise a spending tool at all.

```bash
pnpm install && pnpm -r build

export KEYRING_CONTRACT_ID=keyring-gated-1794298589.testnet
export KEYRING_OWNER_ID=$KEYRING_CONTRACT_ID
export AGENT_ACCOUNT_ID=<agent account>   # omit both to run read-only
export AGENT_PRIVATE_KEY=<agent key>

node packages/mcp-server/dist/bin.js
```

In an MCP client:

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

## Owner console

[`apps/dashboard`](apps/dashboard) is a Vite app over a deployed Keyring,
reading live contract state and signing owner actions through your own wallet.

```bash
pnpm install
pnpm --filter @keyring/dashboard dev     # http://localhost:8787
```

It shows registered agents with per-asset 24-hour quota against each cap,
derived addresses for both chains, every recorded request with the rule that
refused it, and owner-wide budget usage. Owner actions — register, disable,
revoke, set the budget, register the Bitcoin change key — are signed in the
wallet.

Two deliberate properties. **It holds no key**: writes go to the wallet, and
since owner authority comes from `predecessor_account_id()`, a call signed by
anyone else is rejected on chain anyway. And **nothing on it is invented** —
every figure is computed from contract state, with CI failing on placeholder
data, because a console showing plausible fiction cannot be told apart from one
that works.

## The demo

[`evals/transcript.md`](evals/transcript.md) is a real recorded run against the
deployed contract: the agent discovers its address and limits, simulates, makes
a payment that lands on Base Sepolia, is refused three different ways, is
revoked by its owner, and then cannot transact.

```bash
node scripts/demo-agent.mjs    # regenerates the transcript
```

> **Note:** the committed transcript covers native ETH only. It predates the
> ERC-20, Bitcoin and owner-wide-budget work, so it shows less than the system
> now does. Re-running the script regenerates it.

The step worth reading is the revocation. It goes through the SDK with the
owner's key, because **there is no MCP tool for it** — the agent cannot revoke
itself, re-enable itself or raise its own caps, since no such tool exists for
it to be manipulated into calling.

## What is and is not verified

| Claim | Evidence |
|---|---|
| Policy rules enforced at their boundaries | 50 tests, each rule at its cap and one base unit past it |
| Owner and agent access control | 38 tests in the near-sdk VM |
| Signing lifecycle and callback access control | 16 tests |
| EVM construction | 22 tests, matched against viem |
| Bitcoin construction | 23 tests, matched against bitcoinjs-lib |
| SDK and MCP surface | 43 TypeScript tests |
| Real MPC signing | Verified on NEAR testnet, signatures checked independently |
| Payments on two chains | Confirmed in blocks (links above) |
| **Audit** | **None.** No external review of any kind |
| **Mainnet** | **Never.** Testnet accounts and valueless assets only |
| **Multi-input Bitcoin** | Not implemented |
| **Human approval queues, TEE attestation, price oracles** | Out of scope by design |

## Known limitations

The full list, with reasoning, is in [`docs/threat-model.md`](docs/threat-model.md).
The ones that matter most:

1. **A compromised agent key can still spend the remaining 24-hour budget** to
   an allowlisted destination. Keyring bounds blast radius; it does not
   eliminate it. Allowlisting only addresses you control or genuinely intend to
   pay is what makes that bound meaningful.
2. **Owner-wide budgets are opt-in.** Without one, N agents each capped at C
   expose the owner to N × C.
3. **A failed broadcast still consumes budget** until the window rolls.
   Deliberate: refunding on a relayer's report would let a hostile relayer mint
   spend capacity by claiming failure.
4. **A failed signing keeps its reservation.** The contract cannot prove the
   MPC network never assembled a signature, so releasing budget could authorise
   the same spend twice.
5. **Replay protection is bounded** at 32 idempotency keys per agent. The
   uncaught case is a second within-policy payment, never an over-limit one.
6. **The Bitcoin change key is registered by the owner.** The contract cannot
   derive it synchronously. A wrong value sends change to an address Keyring
   does not control, which is why the SDK derives it rather than asking anyone
   to transcribe it.
7. **The MPC wire types are mirrored, not imported.** `near-mpc-sdk` 0.0.1 does
   not compile against `near-sdk` 5.30.1. The schemas were read from the
   deployed signer's own ABI and are pinned by tests, but must be re-checked
   when the signer is upgraded.

## Documentation

| | |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Components, request flow, state layout, events |
| [`docs/threat-model.md`](docs/threat-model.md) | Assets, trust boundaries, 14 threats, residual risks |
| [`docs/security-decisions.md`](docs/security-decisions.md) | 33 decisions with reasoning, including superseded ones |
| [`docs/development.md`](docs/development.md) | Setup, verified commands, gate status |
| [`apps/dashboard`](apps/dashboard) | Owner console, and what it deliberately does not do |
| [`evals/`](evals/) | Recorded agent demo |
| [`CLAUDE.md`](CLAUDE.md) | The engineering contract governing this repository |

## License

MIT. See [`LICENSE`](LICENSE).
