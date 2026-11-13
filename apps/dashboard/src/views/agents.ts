/** Agent cards: the policy boundary, per asset, with derived addresses. */

import { CHAINS } from "../config";
import { derivedAddress } from "../derive";
import { amount, assetInfo, esc, exact, minuteOfDay, spentInWindow, truncate } from "../format";
import { view } from "../rpc";
import type { Agent, ChainPolicy, Keyring } from "../types";
import { quota } from "./quota";

export function agentsView(keyring: Keyring): string {
  if (keyring.agents.length === 0) {
    return `${heading()}
      <div class="card p-5 muted">No agents registered. Register one from <strong>Owner actions</strong>.</div>`;
  }
  return `${heading()}<div class="grid gap-4">${keyring.agents.map((a) => card(keyring, a)).join("")}</div>`;
}

function heading(): string {
  return `<div>
    <h1 class="text-2xl font-semibold tracking-tight">Agents</h1>
    <p class="muted mt-1 max-w-3xl">Each agent is a public key with a policy attached. Limits are per
    asset, because amounts are in each asset's own base units.</p>
  </div>`;
}

function card(keyring: Keyring, agent: Agent, now = Date.now()): string {
  const status = agent.enabled
    ? `<span class="pill pill-ok">Enabled</span>`
    : `<span class="pill pill-warn">Disabled — every request is refused</span>`;

  const window = agent.policy.time_window
    ? `Permitted ${minuteOfDay(agent.policy.time_window.start_minute)}–${minuteOfDay(
        agent.policy.time_window.end_minute,
      )} UTC${
        agent.policy.time_window.start_minute > agent.policy.time_window.end_minute
          ? " (wraps midnight)"
          : ""
      }`
    : "No time restriction";

  return `<div class="card p-5 grid gap-4" data-agent="${esc(agent.public_key)}">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 grid gap-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-base font-semibold">${esc(agent.label)}</span>${status}
        </div>
        <div class="mono text-xs muted break-all">${esc(agent.public_key)}</div>
        <div class="text-xs faint">${esc(window)}</div>
      </div>
      <div class="text-xs muted text-right shrink-0">
        <div>${agent.requests_made} request${agent.requests_made === 1 ? "" : "s"}</div>
        <div>since ${new Date(Number(agent.created_at_ms)).toISOString().slice(0, 10)}</div>
      </div>
    </div>

    <div class="addresses grid gap-2" data-for="${esc(agent.public_key)}">
      <div class="sunken p-3 rounded-lg grid gap-2" aria-busy="true">
        <div class="label faint">Deriving addresses from the MPC signer…</div>
        <div class="bar"><span style="width:40%;animation:pulse 1.2s ease-in-out infinite"></span></div>
      </div>
    </div>

    <div class="grid gap-4">${agent.policy.chains.map((cp) => chainBlock(cp, agent, now)).join("")}</div>

    <div class="flex flex-wrap gap-2 pt-1">
      <button class="btn" data-action="${agent.enabled ? "disable" : "enable"}"
              data-key="${esc(agent.public_key)}">
        ${agent.enabled ? "Disable" : "Re-enable"}
      </button>
      <button class="btn btn-danger" data-action="revoke" data-key="${esc(agent.public_key)}">Revoke</button>
      <span class="text-xs faint self-center">signed by ${esc(keyring.owner)} in your wallet</span>
    </div>
  </div>`;
}

function chainBlock(cp: ChainPolicy, agent: Agent, now: number): string {
  const meta = CHAINS[cp.chain];
  const nativeInfo = assetInfo("native", cp.chain);
  const assets = cp.assets
    .map((ap) => {
      const info = assetInfo(ap.asset, cp.chain);
      const ledger = agent.ledgers.find(
        (l) => l.chain === cp.chain && assetInfo(l.asset, l.chain).key === info.key,
      );
      const spent = ledger ? spentInWindow(ledger.entries, now) : 0n;
      const dests = ap.allowed_destinations;
      return `<div class="pl-3" style="border-left:2px solid var(--surface-line)">
        <div class="flex items-baseline justify-between gap-2 flex-wrap">
          <span class="text-sm font-medium">${esc(info.label)}${
            info.token ? ` <span class="mono text-[11px] faint">${esc(truncate(info.token, 8))}</span>` : ""
          }</span>
          <span class="text-xs muted">per request max
            <span class="exact mono" title="${esc(exact(ap.max_per_request, info))}">${esc(
              amount(ap.max_per_request, info),
            )}</span></span>
        </div>
        ${quota(spent, BigInt(ap.max_per_24h), info)}
        <div class="text-xs mt-1 ${dests.length ? "muted" : "text-[var(--warn)] font-medium"}">
          ${
            dests.length
              ? `${dests.length} allowlisted destination${dests.length === 1 ? "" : "s"}`
              : "no destinations allowlisted — this asset cannot be sent anywhere"
          }
        </div>
        ${dests.length ? `<div class="mono text-[11px] faint break-all">${dests.map(esc).join("<br>")}</div>` : ""}
      </div>`;
    })
    .join("");

  return `<div class="grid gap-2">
    <div class="flex items-baseline justify-between gap-2 flex-wrap">
      <span class="font-medium">${esc(meta?.label ?? cp.chain)}</span>
      <span class="text-xs muted">fee cap
        <span class="exact mono" title="${esc(exact(cp.max_fee, nativeInfo))}">${esc(
          amount(cp.max_fee, nativeInfo),
        )}</span></span>
    </div>
    ${assets}
  </div>`;
}

/**
 * Fills in derived addresses after the cards render.
 *
 * Each address costs a round trip to the MPC signer, which is slow enough to
 * be noticeable, so the cards paint immediately and every lookup runs in
 * parallel behind them. Sequentially this took long enough to look broken.
 */
export async function hydrateAddresses(contractId: string, keyring: Keyring): Promise<void> {
  await Promise.all(
    keyring.agents.map(async (agent) => {
      const box = document.querySelector<HTMLElement>(
        `.addresses[data-for="${CSS.escape(agent.public_key)}"]`,
      );
      if (!box) return;

      const blocks = await Promise.all(
        agent.policy.chains.map(async (cp) => {
          try {
            const path = await view<string>(contractId, "get_derivation_path", {
              owner: keyring.owner,
              public_key: agent.public_key,
              chain: cp.chain,
            });
            const d = await derivedAddress(contractId, path, cp.chain);
            const needsKey = cp.chain === "bitcoin_testnet4";
            const registered = needsKey && agent.btc_pubkey === d.compressed;
            const note = !needsKey
              ? ""
              : registered
                ? `<span class="pill pill-ok">change key registered</span>`
                : `<span class="pill pill-danger">change key not registered — spends are refused</span>`;
            return `<div class="sunken p-3 rounded-lg grid gap-1">
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <span class="label">${esc(CHAINS[cp.chain]?.label ?? cp.chain)} address</span>${note}
              </div>
              <div class="mono text-xs break-all">${esc(d.address)}</div>
              <div class="mono text-[10px] faint break-all">path ${esc(path)}</div>
            </div>`;
          } catch (err) {
            return `<div class="sunken p-3 rounded-lg text-xs text-[var(--danger)]">
              Could not derive the ${esc(cp.chain)} address: ${esc((err as Error).message)}</div>`;
          }
        }),
      );
      box.innerHTML = blocks.join("");
    }),
  );
}
