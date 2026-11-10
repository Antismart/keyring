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
| A — foundation | **Met.** Builds, 73 tests pass, lint clean, interfaces documented, mock signer available. |
| B — policy correctness | Largely covered by the 58 Rust tests. Remaining: MPC success/timeout/failure/partial-signing cases, which need Gate C. |
| C — real NEAR signing | Not started. |
| D — Base Sepolia e2e | Not started. |
| E — Bitcoin e2e | Not started. |
| F — agent workflow | Not started. |
