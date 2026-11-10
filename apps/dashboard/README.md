# Keyring owner console

A read-only dashboard over a deployed Keyring contract. Open it and it loads
live state from NEAR testnet.

```bash
# any static server works; it has no build step
cd apps/dashboard && python3 -m http.server 8787
# then open http://localhost:8787/?account=keyring-gated-1794298589.testnet
```

## Two rules this console follows

**It holds no key and signs nothing.** CLAUDE.md §9 makes the dashboard a
convenience layer, with the contract as the authority. Owner actions —
registering an agent, changing a policy, disabling, revoking, setting the
owner-wide budget — are emitted as the exact `near` CLI command to run, so the
owner's key never reaches a browser. A CLI and the SDK remain sufficient to
operate Keyring without this page at all.

**Nothing on it is invented.** Every figure is computed from contract state:
agent counts, per-asset 24-hour spend, refusal reasons, derived addresses. There
are no placeholder metrics and no sample agents. A console that shows
plausible-looking fiction is worse than no console, because a reader cannot
tell it apart from one that works.

## What it shows

| | |
|---|---|
| **Overview** | Registered agents, requests recorded, refusal rate, signing backend, owner-wide budget usage |
| **Agents** | Per-agent policy, per-asset 24h quota, destination allowlists, time window, derived addresses |
| **Activity** | Every recorded request with the structured reason for each refusal |
| **Owner actions** | Composed CLI commands for the privileged operations |

## Details worth knowing

**Amounts are per asset and never cross-converted.** Caps are in each asset's
own base units — wei, satoshi, token units — because 1 ETH (18 decimals) and
1 USDC (6) are not comparable quantities. Keyring does not spend NEAR at all;
NEAR is where the policy lives and where the contract call's gas is paid.
Hovering any figure shows the exact integer, since policy is enforced on that
rather than on a rounded decimal.

**The rolling window is recomputed here**, matching the contract: entries
strictly newer than `now - 24h` count, so the figure is current rather than a
snapshot the contract stored.

**A mock signer is called out loudly.** If the deployment uses the mock
backend, or any request carries a mock signature, a banner says so and the
backend tile reads `MOCK`. Mock signatures are deterministic stand-ins and are
not valid on any chain.

**A missing Bitcoin change key is surfaced as an error**, because Bitcoin
spends are refused until the owner registers it, and a wrong value would send
change to an address the Keyring does not control.

## Known gaps

- **No wallet connection.** Writes go through the CLI. Adding a wallet selector
  would let the owner act from the page, but it is not needed to operate the
  system and was not worth the risk surface before the submission.
- **Token decimals are a local lookup.** The contract never reads a token's
  decimals. An unrecognised token is shown in raw base units rather than
  guessed at.
- **History is what the contract retains** (bounded per keyring). Older
  activity is reconstructible from the NEP-297 event stream by an indexer.
