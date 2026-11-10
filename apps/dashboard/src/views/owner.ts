/**
 * Owner actions.
 *
 * Every form here composes a contract call and hands it to the owner's wallet.
 * Nothing is validated as authoritative on this page: the contract re-checks
 * each field, so the inputs exist to make a well-formed call easy rather than
 * to decide anything.
 */

import { esc } from "../format";
import type { Keyring } from "../types";

export function ownerView(keyring: Keyring, connected: string | null): string {
  const isOwner = connected === keyring.owner;
  const gate = !connected
    ? `<div class="card p-4" style="border-color:color-mix(in srgb,var(--warn) 40%,transparent)">
        <div class="font-semibold">Connect the owner wallet to act</div>
        <p class="muted text-xs mt-1">Owner authority comes from <span class="mono">predecessor_account_id()</span>
        on the contract call, so these actions must be signed by
        <span class="mono">${esc(keyring.owner)}</span>. The console never holds a key.</p>
      </div>`
    : !isOwner
      ? `<div class="card p-4" style="border-color:color-mix(in srgb,var(--danger) 40%,transparent)">
          <div class="font-semibold text-[var(--danger)]">Connected as a different account</div>
          <p class="muted text-xs mt-1">You are signed in as <span class="mono">${esc(connected)}</span>,
          but this keyring is owned by <span class="mono">${esc(keyring.owner)}</span>. The contract would
          reject these calls.</p>
        </div>`
      : "";

  const agentOptions = keyring.agents
    .map((a) => `<option value="${esc(a.public_key)}">${esc(a.label)} — ${esc(a.public_key)}</option>`)
    .join("");

  const disabled = isOwner ? "" : "disabled";

  return `
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Owner actions</h1>
      <p class="muted mt-1 max-w-3xl">Each action is signed in your wallet. The contract is the authority:
      a call signed by anyone but the owner is rejected on chain.</p>
    </div>
    ${gate}

    <div class="card p-4" style="background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 35%,transparent)">
      <div class="font-semibold">Never paste a private key into a web page.</div>
      <p class="text-xs mt-1">Keyring registers and policy-gates <em>public</em> keys only. An agent's
      private key belongs in its own runtime, and the owner's belongs in the wallet.</p>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <form class="card p-5 grid gap-3" data-form="budget">
        <div>
          <h2 class="font-semibold">Owner-wide 24-hour budget</h2>
          <p class="muted text-xs mt-1">Bounds the total across every agent. Without it, N agents each
          capped at C expose you to N&times;C.</p>
        </div>
        <label class="grid gap-1"><span class="label">Chain</span>
          <select class="field" name="chain">
            <option value="base_sepolia">Base Sepolia</option>
            <option value="bitcoin_testnet4">Bitcoin testnet4</option>
          </select></label>
        <label class="grid gap-1"><span class="label">Cap per 24h, in base units</span>
          <input class="field" name="cap" inputmode="numeric" placeholder="1500000000000" required /></label>
        <p class="text-xs faint">Base units: wei on Base Sepolia, satoshi on Bitcoin. Native asset only
        here; token caps are set per asset in a policy.</p>
        <button class="btn btn-primary" type="submit" ${disabled}>Set budget</button>
      </form>

      <form class="card p-5 grid gap-3" data-form="btckey">
        <div>
          <h2 class="font-semibold">Bitcoin change key</h2>
          <p class="muted text-xs mt-1">Required before an agent can spend on Bitcoin: the contract builds
          the change output itself and cannot derive this key synchronously.</p>
        </div>
        <label class="grid gap-1"><span class="label">Agent</span>
          <select class="field" name="key">${agentOptions}</select></label>
        <label class="grid gap-1"><span class="label">Compressed public key (33 bytes, hex)</span>
          <input class="field" name="compressed" placeholder="02…" required /></label>
        <p class="text-xs faint">The console fills this from the signer when you open an agent — a wrong
        value sends change to an address the Keyring does not control.</p>
        <button class="btn btn-primary" type="submit" ${disabled}>Register key</button>
      </form>

      <form class="card p-5 grid gap-3 lg:col-span-2" data-form="agent">
        <div>
          <h2 class="font-semibold">Register an agent</h2>
          <p class="muted text-xs mt-1">Caps are per asset. An empty destination list permits nobody — it
          is never read as "anyone".</p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="grid gap-1"><span class="label">Agent public key</span>
            <input class="field" name="public_key" placeholder="ed25519:…" required /></label>
          <label class="grid gap-1"><span class="label">Label</span>
            <input class="field" name="label" placeholder="agent-two" required /></label>
          <label class="grid gap-1"><span class="label">Chain</span>
            <select class="field" name="chain">
              <option value="base_sepolia">Base Sepolia</option>
              <option value="bitcoin_testnet4">Bitcoin testnet4</option>
            </select></label>
          <label class="grid gap-1"><span class="label">Fee cap, base units</span>
            <input class="field" name="max_fee" inputmode="numeric" placeholder="100000000000000" required /></label>
          <label class="grid gap-1"><span class="label">Per-request cap, base units</span>
            <input class="field" name="max_per_request" inputmode="numeric" placeholder="1000000000000" required /></label>
          <label class="grid gap-1"><span class="label">24h cap, base units</span>
            <input class="field" name="max_per_24h" inputmode="numeric" placeholder="5000000000000" required /></label>
        </div>
        <label class="grid gap-1"><span class="label">Allowed destinations, one per line</span>
          <textarea class="field" name="destinations" rows="3"
            placeholder="0x1111111111111111111111111111111111111111"></textarea></label>
        <p class="text-xs faint">EVM hex addresses or Bitcoin bech32 addresses. NEAR account ids are not
        valid destinations and the contract rejects them.</p>
        <button class="btn btn-primary" type="submit" ${disabled}>Register agent</button>
      </form>
    </div>

    <div id="owner-result"></div>`;
}
