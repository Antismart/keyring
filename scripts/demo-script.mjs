/**
 * The demo narration, in one place.
 *
 * `say` is what is spoken; `cap` is what appears on screen under it, kept
 * short enough to read at a glance. `el`, where present, is the same sentence
 * spelled for a neural voice (see `spoken`). Both the narrator (scripts/narrate.mjs)
 * and the recorder (scripts/record-demo.mjs) read this file, so the voice
 * track and the picture cannot drift apart: each beat is held for exactly as
 * long as its clip runs.
 *
 * Every claim here is one the repository can support. Nothing describes
 * behaviour that is not implemented, and the limits beat is part of the script
 * rather than a footnote.
 */

export const VOICE = process.env.DEMO_VOICE ?? "Samantha";
export const RATE = Number(process.env.DEMO_RATE ?? 172);

/** Pause after each clip finishes before the next beat starts. */
export const PAD_MS = 900;

export const LINES = [
  {
    id: "open",
    say: "Keyring is policy-enforced wallet infrastructure for A I agents. The premise is that an agent can have financial autonomy without having unrestricted financial authority.",
    el: "Keyring is policy-enforced wallet infrastructure for AI agents. The premise is that an agent can have financial autonomy without having unrestricted financial authority.",
    cap: "Financial autonomy without unrestricted financial authority.",
  },
  {
    id: "problem",
    say: "An agent that can pay needs a key, and a key is unbounded authority. Prompt injection, a bad tool call, a leaked credential — all of them spend in the same way. Keyring takes the key away from the agent.",
    cap: "A key is unbounded authority. Injection, a bad tool call and a leaked credential all spend the same way.",
  },
  {
    id: "how",
    say: "Policy lives in a NEAR smart contract. The agent asks for a transfer; the contract evaluates it, then builds the transaction itself and calls NEAR Chain Signatures to sign it. The agent holds no key and never reaches the signer.",
    cap: "The contract evaluates, then builds the transaction itself, then signs. The agent reaches none of it.",
  },
  {
    id: "overview",
    say: "The owner console, reading live from a contract deployed on NEAR testnet. Every figure here is contract state.",
    cap: "The owner console — every figure is read live from the contract.",
  },
  {
    id: "mpc",
    say: "Signing backend, live M P C. These signatures come from the real NEAR Chain Signatures network, not from a stand-in signer.",
    el: "Signing backend, live MPC. These signatures come from the real NEAR Chain Signatures network, not from a stand-in signer.",
    cap: "Live MPC — the real NEAR Chain Signatures network, not a stand-in.",
  },
  {
    id: "refused",
    say: "Eight requests recorded: six signed, two refused. A refusal costs nothing, because no signature is ever requested for it.",
    cap: "A refusal costs nothing — no signature is requested for it.",
  },
  {
    id: "budget",
    say: "The owner-wide budget: one ceiling across every agent. Per-agent limits cannot express this — ten agents capped at a hundred dollars each is a thousand dollars of exposure.",
    cap: "One ceiling across every agent. Ten agents capped at $100 each is $1,000 of exposure.",
  },
  {
    id: "agents",
    say: "An agent is a public key with a policy attached. This one is enabled, and it has already spent part of its daily allowance.",
    cap: "An agent is a public key with a policy attached.",
  },
  {
    id: "addresses",
    say: "Two addresses, derived by the M P C network from a path that binds owner, agent and chain. Only this contract can obtain signatures for them. That was checked rather than assumed: asking the signer as the agent returns a different key.",
    el: "Two addresses, derived by the MPC network from a path that binds owner, agent and chain. Only this contract can obtain signatures for them. That was checked rather than assumed: asking the signer as the agent returns a different key.",
    cap: "Derived per owner, agent and chain. Only this contract can get signatures for them — asking as the agent returns a different key.",
  },
  {
    id: "btckey",
    say: "The Bitcoin change key is registered. Without it the contract refuses Bitcoin spends outright, rather than sending change to an address it cannot verify.",
    cap: "No registered change key, no Bitcoin spend — change never goes somewhere unverified.",
  },
  {
    id: "caps",
    say: "Limits are per asset and per chain. One E T H at eighteen decimals and one U S D C at six are not comparable quantities, so each asset carries its own cap, its own allowlist and its own fee ceiling — enforced on the integer, never the rounded decimal.",
    el: "Limits are per asset and per chain. One ETH at eighteen decimals and one USDC at six are not comparable quantities, so each asset carries its own cap, its own allowlist and its own fee ceiling — enforced on the integer, never the rounded decimal.",
    cap: "Per asset, per chain: own cap, own allowlist, own fee ceiling — enforced on the integer.",
  },
  {
    id: "activity",
    say: "Every request the contract has recorded, with the rule that decided it.",
    cap: "Every request, with the rule that decided it.",
  },
  {
    id: "refusal",
    say: "This one was refused. The code is owner daily cap exceeded, and the message names the limit, the observed value, and what is already committed across all agents. The agent receives that as a structured result it can act on. The refusal is the product, not an error to hide.",
    cap: "owner_daily_cap_exceeded — the limit, the observed value, and what is already committed across all agents.",
  },
  {
    id: "signed",
    say: "The signed rows cover all three paths: a native E T H transfer, an E R C twenty U S D C transfer, and a Bitcoin testnet four spend. Each was built inside the contract, and each was signed by the live M P C network.",
    el: "The signed rows cover all three paths: a native ETH transfer, an ERC-20 USDC transfer, and a Bitcoin testnet4 spend. Each was built inside the contract, and each was signed by the live MPC network.",
    cap: "Three paths — native ETH, ERC-20 USDC, Bitcoin testnet4. All built in-contract, all signed live.",
  },
  {
    id: "verify",
    say: "You do not have to take the console's word for it. This verifier ran while the recording was being made. It rebuilds the transaction with viem, recomputes the signed hash from the approved fields, checks the signature against the derived key, and recovers that key back out of it.",
    cap: "An independent verifier, run while this was recorded.",
  },
  {
    id: "onchain",
    say: "All three payments settled on their destination chains — two on Base Sepolia, one on Bitcoin testnet four. The same command re-verifies any request from chain data alone.",
    cap: "All three settled on chain. The same command re-verifies any request from chain data alone.",
  },
  {
    id: "owner",
    say: "Owner authority comes from the account that signs the contract call, so this console cannot act on your behalf — it holds no key. The command line stays sufficient without this page.",
    cap: "The console holds no key. Authority comes from the account that signs the call.",
  },
  {
    id: "limits",
    say: "What is not being claimed: nothing audited, nothing on mainnet. Bitcoin is one input, native segwit only. And a compromised agent key can still spend what remains of the day's budget to an allowlisted destination. Keyring bounds the blast radius; it does not remove it.",
    cap: "Not audited. Not on mainnet. Keyring bounds the blast radius — it does not remove it.",
  },
  {
    id: "close",
    say: "Keyring. Open source, running on NEAR testnet today.",
    cap: "github.com/Antismart/keyring",
  },
];

export const byId = Object.fromEntries(LINES.map((l) => [l.id, l]));

/**
 * What a given engine should be handed.
 *
 * `say` needs acronyms spelled out letter by letter or it runs them together;
 * a neural voice reads the spaced form as stilted, so lines that contain one
 * carry an `el` variant with normal spelling.
 */
export function spoken(line, engine) {
  return engine === "elevenlabs" ? (line.el ?? line.say) : line.say;
}

/** Duration in milliseconds of a PCM WAV, at whatever rate it was written. */
export function wavDurationMs(buf) {
  let p = 12;
  let byteRate = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(p + 16);
    if (id === "data") return Math.round((size / byteRate) * 1000);
    p += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}

/** Format and PCM payload of a WAV, for assembling a mixed track. */
export function wavData(buf) {
  let p = 12;
  let fmt = {};
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ")
      fmt = {
        channels: buf.readUInt16LE(p + 10),
        sampleRate: buf.readUInt32LE(p + 12),
        bitsPerSample: buf.readUInt16LE(p + 22),
      };
    if (id === "data") return { ...fmt, start: p + 8, size };
    p += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}
