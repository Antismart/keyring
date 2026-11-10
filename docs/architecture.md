# Architecture

## Components

| Path | What it is | Trust |
|---|---|---|
| `contracts/keyring` | NEAR contract: state, policy engine, events, signer seam | Trusted — the enforcement boundary |
| `packages/sdk` | Typed TypeScript client | Semi-trusted — no authority |
| `packages/mcp-server` | Narrow MCP tool surface for agents | Semi-trusted — no authority |
| `evals/` | Reproducible agent demo transcripts | Documentation |

## Contract modules

| Module | Responsibility |
|---|---|
| `types.rs` | `Chain`, address normalisation and validation, length bounds |
| `policy.rs` | `Policy`, `ChainPolicy`, `TimeWindow`, refusal taxonomy, the evaluator |
| `state.rs` | `Keyring`, `Agent`, `TransferRequest`, `RequestStatus`, spend ledger |
| `events.rs` | NEP-297 structured events |
| `signer.rs` | Signing backend selector, derivation path, deterministic mock |
| `lib.rs` | Public method surface and the request flow |

`policy.rs` holds no NEAR machinery: the evaluator is a pure function over
validated fields and an explicit clock, which is why every rule can be tested at
its boundary without a VM.

## Request flow

```
agent (holds registered key)
  │  request_transfer(chain, destination, amount, fee, idempotency_key)
  ▼
identify agent via env::signer_account_pk()        ── unregistered key → panic
  ▼
look up owner via the global agent-key index
  ▼
idempotency check                                  ── seen before → Duplicate
  ▼
prune expired spend entries
  ▼
normalise destination for the chain                ── malformed → Refused
  ▼
evaluate(enabled, policy, ledger, intent, now)     ── any rule fails → Refused
  ▼
reserve budget   (before any async work)
  ▼
record request as Created, emit events
  ▼
[Gate C] call MPC signer → Signing → Signed | Failed
  ▼
[Gate D/E] relayer broadcasts to Base Sepolia / Bitcoin testnet4
```

Everything from `reserve budget` upward is implemented and tested. Everything in
brackets is not.

## Policy evaluation order

Fixed and deterministic. A request violating several rules always reports the
first one here, so refusals are reproducible and an agent cannot discover a
different limit by reordering its request.

1. `agent_disabled` — the kill switch
2. `chain_not_allowed` — no `ChainPolicy` for that chain
3. `destination_not_allowed` — not in the per-chain allowlist
4. `outside_time_window` — UTC minute of day outside the window
5. `amount_zero`
6. `per_request_cap_exceeded`
7. `fee_cap_exceeded`
8. `daily_cap_exceeded` — projected rolling total over the cap
9. `budget_ledger_full` — no room to record the reservation

Cheap identity and state checks come first; numeric caps run from narrowest to
widest scope.

## State layout

```
Contract
├── keyrings:     IterableMap<AccountId, Keyring>
├── agent_owner:  IterableMap<PublicKey, AccountId>   // global key uniqueness
├── requests:     IterableMap<u64, TransferRequest>
├── next_request_id: u64
└── signer:       SignerBackend

Keyring
├── owner, created_at_ms
├── agents:  Vec<Agent>        // ≤ 16
└── history: Vec<u64>          // ≤ 128, evicting an id deletes its request

Agent
├── public_key, label, enabled, created_at_ms, requests_made
├── policy:      Policy
├── ledgers:     Vec<ChainLedger>       // ≤ 64 entries per chain
└── recent_keys: Vec<IdempotencyRecord> // ≤ 32
```

Every collection is bounded. Full activity history lives in the event stream for
an external indexer; on-contract history is a bounded convenience.

## Budget accounting

A `SpendEntry { at_ms, amount, request_id }` is appended when a request is
authorised — before any asynchronous call. The rolling window is half-open: an
entry exactly `ROLLING_WINDOW_MS` old has expired.

Pruning only ever removes expired entries, so it cannot reduce the in-window
total. When the ledger is full of live entries the request is refused rather
than making room, because evicting a live entry would under-count spend and
silently raise the cap.

No code path releases a reservation based on an external report.

## Events (NEP-297)

Standard `keyring`, version `1.0.0`:

`keyring_created`, `agent_added`, `agent_enabled`, `agent_disabled`,
`agent_revoked`, `policy_changed`, `request_refused`, `request_created`,
`request_status_changed`.

`request_refused` carries the full structured refusal — code, rule, message,
configured limit and observed value — so a refusal is reconstructible from logs
alone.

## Why the signing boundary holds

The agent's request carries four fields and nothing else. There is no parameter
for calldata, a preimage, an output list, a raw hash or a derivation path. The
derivation path is computed by the contract from the owner, the agent label and
the chain.

This means the transaction construction added at Gate D/E takes its inputs
exclusively from values policy approved. Those gates must then *prove* the
constructed transaction matches — against viem for EVM, against a bitcoinjs-lib
fixture for Bitcoin.
