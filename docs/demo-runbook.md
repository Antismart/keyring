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

## Recording it without a camera operator

The walkthrough records itself, narration included.

```bash
pnpm --filter @keyring/dashboard dev     # the console under test

node scripts/narrate.mjs demo                   # a voice clip per line, measured
node scripts/record-demo.mjs \
  "http://localhost:8787/?account=keyring-gated-1794298589.testnet" demo
node scripts/mix-demo.mjs demo                  # picture + voice -> MP4
```

The narrator uses ElevenLabs when `ELEVENLABS_API_KEY` is set (in the
environment or in `.env`, which it reads if present) and the macOS
`say` voice when it is not, so the pipeline runs with no key and no network at
all — only the sound changes. It calls ElevenLabs through the official SDK
(`@elevenlabs/elevenlabs-js`, a root dev dependency) with the pre-made voice
George on `eleven_v4`, and stitches each clip to its neighbours so the tone
holds across beats. `DEMO_VOICE_ID` picks another voice and `ELEVENLABS_MODEL`
another model. To get a key without copying one by hand, run
`npx -y @elevenlabs/cli@latest onboard init` and pass `--env-path .env` to the
`connect` step it prints.

Lines containing acronyms carry a second spelling: `say` needs *M P C* spaced
out or it slurs, while a neural voice reads the spaced form as stilted. Both
live beside each other in `scripts/demo-script.mjs`.

| | |
|---|---|
| `demo/keyring-demo.mp4` | the deliverable — 1440x900, H.264 and AAC, about five minutes |
| `demo/keyring-demo.webm` | the silent capture, if you would rather narrate it yourself |
| `demo/narration.wav` | the voice track alone, already aligned to the picture |
| `demo/cues.md` | every line, when it is spoken, and the caption shown with it |
| `demo/frames/` | a still per beat, usable as submission screenshots |

The narration lives in `scripts/demo-script.mjs` — `say` (or `el`) is what is
spoken, `cap` is what appears on screen. Edit a line there, re-run the three commands,
and the picture is re-cut to the new timing: each beat is held for exactly as
long as its clip runs, so nothing is aligned by hand.

With the `say` fallback, `DEMO_VOICE` and `DEMO_RATE` pick the macOS voice and
words per minute (`say -v '?'` lists them). That fallback is the only
macOS-specific piece; the
recorder falls back to a reading estimate when no clips are present, so the
picture can be shot anywhere and narrated elsewhere.

Two things in the video are produced by the run that made it rather than
quoted from an earlier one: every figure in the console is read from the
deployed contract, and the verifier panel near the end is live output from
`scripts/verify-signature.mjs`. Re-run the recording after changing contract
state rather than editing the video.

`demo/` is gitignored — the MP4 is roughly 15 MB.

## If something goes wrong

**Addresses stuck on "Deriving addresses"** — the signer is slow. They cache
after the first success, so reload and wait. Nothing else on the page depends
on them.

**A tile reads Mock** — wrong contract in the account field.

**A write fails** — check the connected account matches the owner named in the
banner. The contract rejects calls from anyone else.
