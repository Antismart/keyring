# Demo runbook

A recording plan for the Keyring console: the state to set up beforehand, and
the points worth saying out loud.

Contract: `keyring-gated-1794298589.testnet` on NEAR testnet.

## Before you record

```bash
pnpm install && pnpm -r build
pnpm --filter @keyring/dashboard dev
```

Open **http://localhost:8787/?account=keyring-gated-1794298589.testnet** and leave it for ten seconds
before starting. The first load resolves derived addresses from the MPC
signer, which takes several seconds; they are cached afterwards, so the Agents
tab opens instantly on camera.

Check the Overview tile reads **Live MPC**, not Mock. If it says Mock you are
pointed at the wrong deployment.

## The state it is in now

| | |
|---|---|
| Agents | 1 (`agent-one`), enabled, Bitcoin change key registered |
| Owner-wide cap | 0.0000015 ETH per 24h, **67% committed** |
| Requests | 8 recorded — 6 signed, 2 refused |
| Chains | Base Sepolia (ETH and USDC), Bitcoin testnet4 |

The most recent request is a refusal by the owner-wide cap, so it sits at the
top of Activity.

## Running order

### 1 · Overview — what is being claimed (20s)

Four tiles. Point at *Signing backend: Live MPC* and say the signatures come
from the real NEAR Chain Signatures network, not a stub. Point at *Refused
before signing*: a refusal costs nothing, because no signature is requested.

Then the owner-wide budget bar at 67%. This is the thing per-agent caps cannot
express — without it, N agents each capped at C expose the owner to N times C.

### 2 · Agents — the policy boundary (40s)

Two derived addresses appear, one per chain, each with its derivation path.
The MPC signer binds every key to its caller, so only this contract can obtain
signatures for these addresses. That was checked rather than assumed: asking
the signer with the agent's own account returns a different key.

Note *change key registered* on the Bitcoin block. Without it the contract
refuses Bitcoin spends outright rather than sending change somewhere it cannot
verify.

Then the per-asset quotas. ETH, USDC and BTC each carry their own cap, because
1 ETH at 18 decimals and 1 USDC at 6 are not comparable quantities. Hover a
figure to reveal the exact integer — policy is enforced on that, not on the
rounded decimal.

### 3 · Activity — the refusal is the product (40s)

The top row is `owner_daily_cap_exceeded`. Read the message: it names the
limit, the observed value, and how much is already committed across all
agents. An agent receives this as an ordinary result and can act on it.

Scroll to the signed rows and point out all three asset paths — native ETH,
USDC and BTC — each signed by the live MPC network.

### 4 · Owner actions — where authority lives (30s)

The buttons stay disabled until a wallet connects, and the banner explains
why: owner authority comes from `predecessor_account_id()` on the contract
call, so the console cannot act for you. Say plainly that it holds no key and
that the CLI remains sufficient without it.

For a live write, connect MyNearWallet as the owner, disable `agent-one` from
the Agents tab, then show the next request refused with `agent_disabled`.
Re-enable afterwards.

## What to say about the limits

Say these rather than hope nobody asks:

- Nothing has been audited, and nothing has touched mainnet.
- Bitcoin is one input, native segwit only. Multiple inputs are unsupported
  rather than half-supported.
- A compromised agent key can still spend the remaining 24-hour budget to an
  allowlisted destination. Keyring bounds blast radius; it does not remove it.

## On-chain receipts, if asked

| | |
|---|---|
| Native ETH | Base Sepolia block 56931717 |
| ERC-20, 1 USDC | Base Sepolia block 56963072 |
| Native BTC | Bitcoin testnet4 block 160377 |

`node scripts/verify-signature.mjs keyring-gated-1794298589.testnet <id>` re-verifies any request from
chain data alone: it rebuilds the transaction with viem or bitcoinjs-lib,
checks the signature against the MPC-derived key, and recovers that key from
the signature.

## If something goes wrong

**Addresses stuck on "Deriving addresses"** — the signer is slow. They cache
after the first success, so reload and wait. Nothing else on the page depends
on them.

**A tile reads Mock** — wrong contract in the account field.

**A write fails** — check the connected account matches the owner named in the
banner. The contract rejects calls from anyone else.
