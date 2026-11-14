# Owner console — design brief

For a redesign done in Framer (or any design tool) that has to come back into
`apps/dashboard` by hand. Framer cannot host this app: it reads live contract
state over NEAR RPC and derives addresses from the MPC signer. The design is
the deliverable; the port is manual.

## What makes the port cheap

`apps/dashboard/src/styles.css` is 158 lines and entirely token-driven. Every
colour is a custom property, and every repeated element is one of twelve
primitives. Nothing in the view files names a colour.

A redesign ports back in two steps when it is expressed as **token values plus
primitive rules**. It becomes a rewrite the moment it is expressed as
free-form frames, because layout lives in Tailwind utilities inside the view
files.

### The tokens — all 28

| Group | Tokens |
|---|---|
| Surfaces | `--surface` `--surface-raised` `--surface-sunken` `--surface-line` |
| Text | `--fg` `--fg-muted` `--fg-faint` |
| Accent | `--accent` `--accent-soft` |
| Status | `--ok` `--ok-soft` `--warn` `--warn-soft` `--danger` `--danger-soft` |
| Rail | `--rail` `--rail-fg` `--rail-line` |
| Type | `--font-sans` `--font-mono` |

Each has a light value and a dark value. The rail stays dark in both themes —
it is chrome, not content.

### The primitives — all 12

`.card` · `.sunken` · `.pill` (ok / warn / danger / neutral) · `.btn`
(default / primary / danger / disabled) · `.field` · `.label` · `.bar`
(normal / near / over) · `table.data` · `.rail` (link, hover, current) ·
`.code` · `.mono` · `.exact`

A redesign that changes only these is a stylesheet swap. One that adds a
thirteenth primitive is fine; one that dissolves these into bespoke styling
per screen is not.

## The four screens

Real content, taken from the deployed contract. Use it — do not invent
figures. CI rejects fabricated strings in the dashboard source.

### Overview
Four stat tiles: **Agents** 1 of 1 enabled · **Requests** 8, 6 signed 2
refused · **Refused before signing** 25% · **Signing backend** Live MPC
(`v1.signer-prod.testnet`). Then the owner-wide budget card: Base Sepolia ·
ETH, `0.000001 ETH of 0.0000015 ETH`, a bar at 67%. Then a prose card
explaining where enforcement happens.

The *Signing backend* tile reads **Mock** in red when any signature is a
stand-in. That state must stay visually alarming.

### Agents
One card per agent. Header: label, Enabled/Disabled pill, the ed25519 public
key, time window, request count. Then the derived addresses block — one row
per chain with the address and its derivation path, and a `change key
registered` pill on the Bitcoin row. Then per-chain policy: fee cap, and per
asset a cap, a spend bar, and the destination allowlist. Then Disable and
Revoke buttons.

States to design: addresses still resolving (`aria-busy`, pulsing bar);
Bitcoin change key *not* registered (danger pill); agent disabled (every row
muted).

### Activity
One table, seven columns: `#`, Status, Chain / asset, Amount, Destination, Fee
(derived), Outcome. Status is a pill — Signed, Refused, Failed, Signing,
Created. The Outcome cell carries the weight: for a refusal, the code in
monospace danger (`owner_daily_cap_exceeded`), the full message beneath it,
then `limit … · observed …` in small monospace.

**This is the screen judges look at.** The refusal is the product, not an
error state to tone down.

### Owner actions
A gate card when no wallet is connected, a different one when the connected
account is not the owner. Then forms: owner-wide 24-hour budget, Bitcoin
change key, register an agent. Every control disabled until the owner
connects.

## Constraints

- **Both themes, designed not inverted.** Light is the default; dark is what
  the demo is recorded in.
- **Phone width (400px) must work.** The rail collapses; the Activity table
  scrolls inside its own container while the page does not scroll sideways.
- **Amounts are monospace with tabular numerals**, and carry a dotted
  underline (`.exact`) whose tooltip shows the exact integer. Policy is
  enforced on the integer; the decimal is a convenience.
- **Addresses, keys, paths, payload hashes: monospace, and they wrap.** A
  Bitcoin address at 400px must not push the page wider.
- **No invented data.** No placeholder agent names, no rounded-looking
  figures, no fake transaction hashes.

## What must not change

The copy that carries the security claims: the refusal messages, the
`predecessor_account_id()` explanation on Owner actions, the "never paste a
private key" warning, and the enforcement-path paragraph on Overview. These
are reviewed statements, not filler.

## Porting back

1. Replace the token values in `styles.css` — both theme blocks.
2. Replace the primitive rules.
3. Only then touch layout in `src/views/*.ts`, which is Tailwind utilities.
4. `pnpm --filter @keyring/dashboard build` then
   `node scripts/screenshot-dashboard.mjs <url> <dir>` — it reports console
   errors and horizontal overflow, and captures both themes, phone width and
   every tab.
5. Re-record the demo: `scripts/record-demo.mjs` spotlights elements by
   selector (`.addresses`, `.pill:has-text("change key registered")`,
   `table.data tbody tr`). If a class disappears, the recording breaks.
