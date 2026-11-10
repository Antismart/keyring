# Development

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Rust | 1.99 | Pinned in `rust-toolchain.toml` |
| `wasm32-unknown-unknown` | — | `rustup target add wasm32-unknown-unknown` |
| `cargo-near` | **≥ 0.23.0** | 0.19.0 **cannot** build this contract |
| Node.js | ≥ 22 | 22.19.0 verified |
| pnpm | 10.17.1 | `packageManager` field |
| near-cli-rs | 0.23.5 | Needed from Gate C |

> `cargo-near` 0.19.0 refuses wasm built with rustc ≥ 1.87, while `near-sdk`
> 5.30.1 requires rustc ≥ 1.95 — an impossible pair. If you see
> "please downgrade to 1.86.0 toolchain", your `cargo-near` is too old:
> `cargo install --locked cargo-near --version 0.23.0`.
> Full detail in `docs/security-decisions.md` §9.

## Setup

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked cargo-near --version 0.23.0
pnpm install
```

## Commands

All verified on macOS 26.6 / arm64.

```bash
# Contract
cargo fmt --all --check
cargo clippy --target wasm32-unknown-unknown -- -D warnings   # lib, real target
cargo clippy --tests -- -D warnings                           # tests, host target
cargo test --workspace                                        # 58 tests

# Contract wasm + ABI  (must run from the crate, not the workspace root)
cd contracts/keyring && cargo near build non-reproducible-wasm

# TypeScript
pnpm -r typecheck
pnpm -r build
pnpm -r test
```

### Why two clippy invocations

`near-sdk` emits a deliberate `compile_error!` for a plain host-target
`cargo build`, so the contract library must be checked against
`wasm32-unknown-unknown`. The tests need the host target, where the
`unit-testing` feature and the mock VM are available. `cargo build` at the
workspace root will fail by design — use `cargo check --target
wasm32-unknown-unknown` or `cargo near build`.

## Test layout

| File | Scope |
|---|---|
| `contracts/keyring/tests/policy_boundaries.rs` | 30 tests. Pure evaluator, every rule at and one base unit past its cap. |
| `contracts/keyring/tests/contract_access_control.rs` | 28 tests. Owner-only mutation, agent identity, idempotency, aggregate budget, views. |
| `contracts/keyring/tests/common/mod.rs` | Shared fixtures. |
| `packages/mcp-server/test/tools.test.ts` | 12 tests. Tool input validation. |
| `packages/sdk/test/types.test.ts` | 3 tests. Outcome narrowing. |

TypeScript tests import from `dist/`, so they exercise the built artifact. The
test scripts run `tsc -b` first.

## Environment variables

Copy `.env.example` to `.env` (gitignored) and fill it locally. Never commit real
values; `.env.example` holds names only. CI greps for committed key material and
fails on a hit.

Not needed until Gate C — Gate A and B run entirely on the mock signer with no
credentials and no network.

## Gate status

| Gate | State |
|---|---|
| A — foundation | **Met.** Builds, lint clean, interfaces documented, mock signer available. |
| B — policy correctness | **Met.** 72 Rust tests: every rule at both sides of its boundary, access control, aggregate budget, MPC success and failure paths. Partial signing does not apply to the single-payload secp256k1 flow. |
| C — real NEAR signing | **Met.** Deployed to testnet, real signature from the live signer, callback lifecycle tested, signature independently verified, no direct agent-to-MPC path. |
| D — Base Sepolia e2e | **Met.** EIP-1559 built in-contract and matched against viem, signed by the live MPC network, included in block 56892318. Destination, per-request and fee-cap refusals all returned before signing. |
| E — Bitcoin e2e | **Met.** BIP143 sighash matched against bitcoinjs-lib, signed by the live MPC network, and a spend confirmed in testnet4 block 160377 with outputs and fee cap enforced. |
| ERC-20 | **Met in construction.** Calldata composed in-contract, matched against viem, signed on testnet. Not broadcast: no test tokens held. |
| Owner-wide budgets | **Met.** Enforced on testnet; refused a request the agent's own cap allowed. |
| F — agent workflow | **Met.** MCP server implemented over stdio and driven against the deployed contract; `evals/transcript.md` records a real payment, three refusals, owner revocation and the audit trail. |

## Testnet verification

The Gate C deployment used to verify real signing:

| | |
|---|---|
| Keyring contract | `keyring-gatec-1794295861.testnet` |
| MPC signer | `v1.signer-prod.testnet` (version 3.18.0) |
| Domain | 0 — CaitSith, purpose Sign, secp256k1 |

Re-verify a signature from chain data alone. The script shares no code with the
contract: it recomputes the payload, fetches the derived key from the signer,
verifies the ECDSA signature, and recovers the public key from the signature to
confirm it is the same key.

```bash
node scripts/verify-signature.mjs keyring-gatec-1794295861.testnet 1 testnet
```

To reproduce a deployment from scratch you need a testnet account:

```bash
near account create-account sponsor-by-faucet-service YOUR.testnet \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create

cd contracts/keyring && cargo near build non-reproducible-wasm && cd -

near contract deploy YOUR.testnet \
  use-file target/near/keyring_contract/keyring_contract.wasm \
  with-init-call new json-args \
  '{"signer":{"mpc":{"contract_id":"v1.signer-prod.testnet"}}}' \
  prepaid-gas '100 TGas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send
```

A `request_transfer` call must attach about 300 TGas: the contract forwards
100 TGas to the signer and reserves 20 TGas for its own callback.

## MCP server

```bash
pnpm -r build
KEYRING_CONTRACT_ID=keyring-gated-1794298589.testnet \
AGENT_ACCOUNT_ID=<agent> AGENT_PRIVATE_KEY=<key> \
node packages/mcp-server/dist/bin.js
```

Without `AGENT_ACCOUNT_ID` and `AGENT_PRIVATE_KEY` the server starts read-only
and does not register `request_transfer` at all. With
`KEYRING_AUTO_BROADCAST=true` a signed transfer is broadcast immediately;
otherwise the signature is returned for `scripts/broadcast-evm.mjs`.

Regenerate the demo transcript with `node scripts/demo-agent.mjs` (see
`evals/README.md` for the variables it needs).

## Base Sepolia

| | |
|---|---|
| Keyring contract | `keyring-gated-1794298589.testnet` |
| Derived address | `0xbd0748719c9defaff838e0a810a00b0eb563cc53` |
| Chain id | 84532 (confirmed via `eth_chainId`) |
| Bitcoin address | `tb1qthnksfdpen20ka34h9dhapdgttwxcdr4z4nhgm` |
| Verified Bitcoin spend | [`15061f1f6bb2fd892018621bb8523dff7ddef6bf0d672f01b56441eb225aaeee`](https://mempool.space/testnet4/tx/15061f1f6bb2fd892018621bb8523dff7ddef6bf0d672f01b56441eb225aaeee) |
| Verified payment | [`0x03f49320c7aa0dcd2126f2a1ab247e0025b1aef8fa23955ab6bfc4d9bce43014`](https://sepolia.basescan.org/tx/0x03f49320c7aa0dcd2126f2a1ab247e0025b1aef8fa23955ab6bfc4d9bce43014) |

```bash
# Regenerate the viem reference fixtures, or check them without writing
node scripts/gen-evm-fixtures.mjs
node scripts/gen-evm-fixtures.mjs --check

# Assemble and broadcast a signed request
node scripts/broadcast-evm.mjs keyring-gated-1794298589.testnet 1
```

The broadcast script refuses to send unless the recomputed signing hash matches
the contract's record, the assembled transaction still carries the approved
recipient and value, and the signature recovers to the derived Keyring address.

## Resetting a development deployment

The state layout changes when the policy model changes, which makes old records
undeserialisable. `migrate_reset` installs fresh state under a new storage
prefix version:

```bash
near contract deploy keyring-gated-1794298589.testnet \
  use-file target/near/keyring_contract/keyring_contract.wasm \
  with-init-call migrate_reset json-args \
  '{"signer":{"mpc":{"contract_id":"v1.signer-prod.testnet"}},"prefix_version":2}' \
  prepaid-gas '100 TGas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send
```

The prefix version must not have been used on that account before: a fresh
`IterableMap` over the same prefix still reads what the old layout wrote there.
Old entries are orphaned, not deleted, so their storage stake stays locked.
This is a development tool and is unsuitable for a deployment holding real
policy — see `security-decisions.md` §28.

## Enabling Bitcoin for an agent

```bash
# Derive the key and address from the MPC signer, then register the key.
node -e "import('./packages/sdk/dist/index.js').then(async m => {
  const k = await m.deriveBitcoinKey({
    path: 'keyring-v1,keyring-gated-1794298589.testnet,agent-one,bitcoin-testnet4',
    predecessor: 'keyring-gated-1794298589.testnet' });
  console.log(k.compressedPubkey, k.address);
})"
```

Register the compressed key with `set_agent_btc_pubkey`, then fund the address.
A spend is refused outright while no key is registered, rather than sending
change anywhere unverified.

## Broadcasting a Bitcoin spend

```bash
node scripts/broadcast-btc.mjs <keyring-account> <request-id>
```

The script refuses to send unless the registered Bitcoin key matches the one
the signer derives, the recomputed sighash matches the contract's record, the
signature verifies, and the outputs are exactly the approved payment plus
change to the Keyring address. It normalises the signature to low-S, which
Bitcoin requires and the MPC network does not guarantee.

A testnet4 API that is reachable is needed; `mempool.space` was unavailable
from the development machine, so the default is `blockstream.info/testnet4`.
