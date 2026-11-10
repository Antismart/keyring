# Keyring owner console

A Vite application over a deployed Keyring contract. It reads live state from
NEAR testnet and lets the owner act through their own wallet.

```bash
pnpm install
pnpm --filter @keyring/dashboard dev      # http://localhost:8787
pnpm --filter @keyring/dashboard build    # typecheck, then bundle to dist/
pnpm --filter @keyring/dashboard verify   # render checks against a live deployment
```

Load a different keyring with `?account=<id>`, or type one into the header.

## Two rules this console follows

**It holds no key.** Reads go over plain JSON-RPC. Writes — registering an
agent, disabling, revoking, setting the owner-wide budget, registering the
Bitcoin change key — are handed to the owner's wallet to sign, so the key
never reaches this code. That is not only hygiene: owner authority on the
contract comes from `predecessor_account_id()`, so a call signed by anyone
else is rejected on chain regardless of what this page sends. The console
shows when the connected account is not the owner, rather than letting the
call fail on chain.

**Nothing on it is invented.** Every figure is computed from contract state.
There are no placeholder metrics and no sample agents, and CI fails on the
specific fictions from the design this was built from. A console that shows
plausible-looking fiction is worse than none, because a reader cannot tell it
apart from one that works.

## What it shows

| | |
|---|---|
| **Overview** | Agents enabled, requests recorded, share refused before signing, signing backend, owner-wide budget usage |
| **Agents** | Per-asset 24-hour quota against each cap, destination allowlists, time window, derived addresses for every configured chain |
| **Activity** | Every recorded request with the structured reason for each refusal |
| **Owner actions** | Register an agent, set the owner-wide budget, register the Bitcoin change key — each signed in your wallet |

## Details worth knowing

**Amounts are per asset and never cross-converted.** Caps are in each asset's
own base units — wei, satoshi, token units — because 1 ETH at 18 decimals and
1 USDC at 6 are not comparable quantities. Keyring does not spend NEAR at all;
NEAR is where the policy lives and where the contract call's gas is paid.
Hovering any figure reveals the exact integer, since policy is enforced on that
rather than on a rounded decimal.

**The rolling window is recomputed in the page**, with the contract's
half-open boundary, so a quota is current rather than a stored snapshot.

**Two states are surfaced as problems** rather than left to be discovered: a
mock signer, whose signatures are stand-ins valid on no chain, and a missing
Bitcoin change key, which causes Bitcoin spends to be refused. The Bitcoin key
field is filled from the signer rather than typed, because a wrong value sends
change to an address the Keyring does not control.

**The wallet layer is a lazy chunk.** It pulls in wallet-selector and the NEAR
libraries beneath it — most of the bundle — and reading a keyring needs none of
it. The initial load is about 47 kB; the 760 kB wallet chunk arrives only when
you connect, or on load if a previous session is remembered.

## Known gaps

- **MyNearWallet only.** Meteor's SDK imports `utils` from `near-api-js`, which
  version 7 removed, and this workspace resolves 7 for the SDK — so adding it
  breaks the build rather than adding a wallet. Other wallets can be added once
  that resolves.
- **`register_agent` covers one chain and the native asset.** Multi-asset and
  token policies are set through the SDK or CLI, which take the full policy
  object. The form exists to make the common case easy, not to be the only way.
- **A transitive dependency uses direct `eval`.** `js-sha256`, pulled in under
  wallet-selector, uses `eval("require('buffer').Buffer")` for Node detection;
  the bundler warns about it. That branch does not run in a browser, but it is
  worth knowing about in a security-sensitive project.
- **Token decimals are a local lookup.** The contract never reads a token's
  decimals. An unrecognised token is shown in raw base units rather than
  guessed at.
- **History is what the contract retains**, bounded per keyring. Older activity
  is reconstructible from the NEP-297 event stream by an indexer.
