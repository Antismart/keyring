/**
 * Keyring owner console.
 *
 * Reads live state from the Keyring contract over NEAR JSON-RPC and renders it.
 * Two rules govern this file:
 *
 *  1. **Nothing is invented.** Every number shown is computed from contract
 *     data. There are no placeholder metrics, no sample agents and no estimated
 *     figures — a console that displays plausible-looking fiction is worse than
 *     no console, because it cannot be told apart from one that works.
 *
 *  2. **It holds no key and signs nothing.** CLAUDE.md §9 makes the dashboard a
 *     convenience layer; the contract is the authority. Owner actions are
 *     emitted as commands to run, so the owner's key never reaches the browser.
 *
 * Amounts are per asset and never cross-converted: wei on Base Sepolia,
 * satoshi on Bitcoin, token base units for ERC-20. Keyring does not spend NEAR
 * at all — NEAR is where the policy lives.
 */

import { keccak_256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/esm/sha3.js";
import { ripemd160 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/esm/legacy.js";
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/esm/sha2.js";
import { base58, bech32 } from "https://cdn.jsdelivr.net/npm/@scure/base@1.2.6/lib/esm/index.js";

const NEAR_RPC = "https://rpc.testnet.near.org";
const MPC_SIGNER = "v1.signer-prod.testnet";
const ECDSA_DOMAIN_ID = 0;
/** Must match the contract: the window is half-open. */
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACCOUNT = "keyring-gated-1794298589.testnet";

/** Display metadata per chain. Decimals are for presentation only. */
const CHAINS = {
  base_sepolia: { label: "Base Sepolia", short: "base-sepolia", symbol: "ETH", decimals: 18, explorer: "https://sepolia.basescan.org" },
  bitcoin_testnet4: { label: "Bitcoin testnet4", short: "bitcoin-testnet4", symbol: "BTC", decimals: 8, explorer: "https://mempool.space/testnet4" },
};

/**
 * Tokens whose decimals we know, for display only.
 *
 * The contract never reads a token's decimals; amounts are always its smallest
 * unit. An unknown token is shown in raw units rather than guessed at.
 */
const TOKENS = {
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { symbol: "USDC", decimals: 6 },
};

// ───────────────────────────────── helpers

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (s, n = 10) => (s && s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s ?? "—");
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Describes an asset for display, with its unit and decimals. */
function assetInfo(asset, chain) {
  if (asset === "native") {
    const c = CHAINS[chain] ?? {};
    return { key: "native", label: c.symbol ?? "native", decimals: c.decimals ?? 0, unit: chain === "bitcoin_testnet4" ? "sat" : "wei" };
  }
  const token = asset.erc20.token.toLowerCase();
  const known = TOKENS[token];
  return {
    key: `erc20:${token}`,
    label: known ? known.symbol : `token ${short(token, 6)}`,
    decimals: known ? known.decimals : 0,
    unit: "token base units",
    token,
  };
}

/** Formats an integer base-unit string for humans. */
function amount(raw, info) {
  const v = BigInt(raw);
  if (info.decimals === 0) return `${v.toLocaleString()} ${info.unit}`;
  const d = BigInt(10) ** BigInt(info.decimals);
  const whole = v / d;
  const frac = (v % d).toString().padStart(info.decimals, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ${info.label}`;
}

/**
 * A formatted amount that still exposes its exact integer.
 *
 * Decimal rendering of small balances hides precision — 1e12 wei reads as
 * "0.000001 ETH" — and policy is enforced on the integer, not the rounded
 * figure. The raw base-unit value is always one hover away.
 */
function amountCell(raw, info) {
  const unit = info.decimals === 0 ? info.unit : info.unit ?? "base units";
  return `<span class="underline decoration-dotted decoration-outline-variant cursor-help" title="${esc(BigInt(raw).toString())} ${esc(unit)}">${esc(amount(raw, info))}</span>`;
}

/** Sum of entries still inside the rolling window. Mirrors the contract. */
function spentInWindow(entries, nowMs) {
  const cutoff = nowMs - ROLLING_WINDOW_MS;
  return entries
    .filter((e) => e.at_ms > cutoff)
    .reduce((acc, e) => acc + BigInt(e.amount), 0n);
}

async function view(contractId, method, args = {}) {
  const res = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "keyring-console",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.data?.message ?? body.error.message ?? "RPC error");
  if (body.result?.error) throw new Error(body.result.error);
  const text = new TextDecoder().decode(new Uint8Array(body.result.result));
  return text.length ? JSON.parse(text) : null;
}

// ───────────────────────────── address derivation

/** An EVM address is the last 20 bytes of keccak over the 64 raw key bytes. */
function evmAddress(nearKey) {
  const raw = base58.decode(nearKey.split(":")[1]);
  return `0x${hex(keccak_256(raw).slice(12))}`;
}

/** Bitcoin wants the compressed key: 0x02/0x03 by the parity of y, then x. */
function compress(nearKey) {
  const raw = base58.decode(nearKey.split(":")[1]);
  const out = new Uint8Array(33);
  out[0] = (raw[63] & 1) === 0 ? 0x02 : 0x03;
  out.set(raw.subarray(0, 32), 1);
  return out;
}

function btcAddress(nearKey) {
  const program = ripemd160(sha256(compress(nearKey)));
  return bech32.encode("tb", [0, ...bech32.toWords(program)]);
}

async function derivedAddress(contractId, path, chain) {
  const key = await view(MPC_SIGNER, "derived_public_key", {
    path,
    predecessor: contractId,
    domain_id: ECDSA_DOMAIN_ID,
  });
  return {
    publicKey: key,
    address: chain === "bitcoin_testnet4" ? btcAddress(key) : evmAddress(key),
    compressed: chain === "bitcoin_testnet4" ? hex(compress(key)) : null,
  };
}

// ───────────────────────────────── rendering

const state = { account: null, keyring: null, requests: [], signer: null, now: Date.now() };

function banner(kind, html) {
  const b = $("#banner");
  const styles = {
    error: "bg-error-container text-on-error-container",
    warn: "bg-amber-50 text-amber-900",
    info: "bg-surface-container-low text-on-surface-variant",
  };
  b.className = `p-3 rounded-xl flex items-start gap-2 ${styles[kind]}`;
  b.innerHTML = `<span class="material-symbols-outlined text-[18px] flex-shrink-0">${
    kind === "error" ? "error" : kind === "warn" ? "warning" : "info"
  }</span><div>${html}</div>`;
  b.hidden = false;
}

function tile(label, value, sub, icon, tone = "text-primary") {
  return `<div class="p-4 rounded-xl bg-surface-container-lowest shadow-sm flex items-center justify-between gap-3">
    <div class="min-w-0">
      <div class="text-xs text-secondary uppercase tracking-wider font-semibold">${esc(label)}</div>
      <div class="text-xl font-semibold mt-0.5 truncate">${value}</div>
      ${sub ? `<div class="text-xs text-secondary mt-0.5">${sub}</div>` : ""}
    </div>
    <div class="w-10 h-10 rounded-lg bg-surface-container-low flex items-center justify-center ${tone} flex-shrink-0">
      <span class="material-symbols-outlined text-[22px]">${icon}</span>
    </div>
  </div>`;
}

function quotaBar(spent, cap, tone) {
  const pct = cap === 0n ? 0 : Number((spent * 1000n) / cap) / 10;
  const clamped = Math.min(100, pct);
  const colour = pct >= 96 ? "bg-amber-500" : pct >= 100 ? "bg-error" : "bg-primary-container";
  return `<div class="w-full h-1.5 bg-surface-container rounded-full overflow-hidden">
    <div class="h-full ${tone ?? colour} rounded-full" style="width:${clamped}%"></div>
  </div><div class="text-[11px] text-secondary mt-0.5">${pct.toFixed(pct < 10 ? 1 : 0)}% of the 24h cap committed</div>`;
}

function renderOverview() {
  const k = state.keyring;
  const agents = k.agents;
  const enabled = agents.filter((a) => a.enabled).length;
  const refusals = state.requests.filter((r) => r.status === "refused").length;
  const signed = state.requests.filter((r) => r.status === "signed").length;
  const mockAny = state.requests.some((r) => r.signature?.mock);

  $("#tiles").innerHTML = [
    tile("Registered agents", `${enabled} <span class="text-sm text-secondary font-normal">/ ${agents.length} enabled</span>`, null, "smart_toy"),
    tile("Requests recorded", String(state.requests.length), `${signed} signed · ${refusals} refused`, "receipt_long"),
    tile("Refusal rate", state.requests.length ? `${Math.round((refusals / state.requests.length) * 100)}%` : "—",
      "refused before any signature", "gavel", refusals ? "text-tertiary" : "text-primary"),
    tile("Signing backend", mockAny ? "MOCK" : "Live MPC",
      esc(state.signer?.mpc?.contract_id ?? "mock signer"), mockAny ? "science" : "verified_user",
      mockAny ? "text-error" : "text-primary"),
  ].join("");

  // Owner-wide budget: the cap per-agent limits cannot express.
  const caps = k.aggregate?.caps ?? [];
  const sec = $("#budget-section");
  if (caps.length === 0) {
    sec.innerHTML = `<div class="flex items-center gap-2 font-semibold"><span class="material-symbols-outlined text-[20px] text-secondary">account_balance_wallet</span>Owner-wide budget</div>
      <p class="text-secondary">No keyring-wide cap is set, so each agent is bounded only by its own limits.
      With N agents each capped at C, total exposure is N&times;C. Set one with
      <span class="mono text-xs">set_aggregate_budget</span>.</p>`;
    return;
  }
  const rows = caps.map((cap) => {
    const info = assetInfo(cap.asset, cap.chain);
    const ledger = (k.ledgers ?? []).find(
      (l) => l.chain === cap.chain && assetInfo(l.asset, l.chain).key === info.key,
    );
    const spent = ledger ? spentInWindow(ledger.entries, state.now) : 0n;
    const capV = BigInt(cap.max_per_24h);
    return `<div class="space-y-1">
      <div class="flex items-baseline justify-between gap-3 flex-wrap">
        <span class="font-medium">${esc(CHAINS[cap.chain]?.label ?? cap.chain)} · ${esc(info.label)}</span>
        <span class="mono text-xs">${amountCell(spent.toString(), info)} / ${amountCell(cap.max_per_24h, info)}</span>
      </div>
      ${quotaBar(spent, capV)}
    </div>`;
  });
  sec.innerHTML = `<div class="flex items-center gap-2 font-semibold"><span class="material-symbols-outlined text-[20px] text-primary">account_balance_wallet</span>Owner-wide budget</div>
    <p class="text-secondary">Caps the total across <strong>every</strong> agent, which per-agent limits cannot do.</p>
    <div class="space-y-3 pt-1">${rows.join("")}</div>`;
}

function statusPill(status, mock) {
  const map = {
    signed: ["bg-emerald-50 text-emerald-700", "check_circle", mock ? "Signed (mock)" : "Signed"],
    refused: ["bg-red-50 text-error", "do_not_disturb_on", "Refused"],
    failed: ["bg-red-50 text-error", "error", "Failed"],
    signing: ["bg-amber-50 text-amber-800", "hourglass_top", "Signing"],
    created: ["bg-surface-container text-secondary", "schedule", "Created"],
  };
  const [cls, icon, label] = map[status] ?? ["bg-surface-container text-secondary", "help", status];
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cls}">
    <span class="material-symbols-outlined text-[13px]">${icon}</span>${esc(label)}</span>`;
}

async function renderAgents() {
  const k = state.keyring;
  const list = $("#agents-list");
  if (k.agents.length === 0) {
    list.innerHTML = `<div class="p-5 rounded-xl bg-surface-container-lowest shadow-sm text-secondary">
      No agents registered. Register one from <strong>Owner actions</strong>.</div>`;
    return;
  }
  list.innerHTML = "";

  for (const agent of k.agents) {
    const card = el("div", "p-5 rounded-xl bg-surface-container-lowest shadow-sm space-y-4");

    const chainsSummary = agent.policy.chains
      .map((cp) => `<span class="px-2 py-0.5 bg-surface-container rounded text-xs font-medium">${esc(CHAINS[cp.chain]?.label ?? cp.chain)}</span>`)
      .join(" ");

    card.innerHTML = `
      <div class="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-base font-semibold">${esc(agent.label)}</span>
            ${agent.enabled
              ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700"><span class="w-1.5 h-1.5 rounded-full bg-primary-container"></span>Enabled</span>`
              : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800"><span class="material-symbols-outlined text-[13px]">pause_circle</span>Disabled — every request is refused</span>`}
          </div>
          <div class="mono text-xs text-secondary break-all">${esc(agent.public_key)}</div>
          <div class="flex items-center gap-1 flex-wrap pt-1">${chainsSummary}</div>
        </div>
        <div class="text-xs text-secondary lg:text-right flex-shrink-0">
          <div>${agent.requests_made} request${agent.requests_made === 1 ? "" : "s"} made</div>
          <div>registered ${new Date(Number(agent.created_at_ms)).toISOString().slice(0, 10)}</div>
        </div>
      </div>
      <div class="addresses space-y-2"></div>
      <div class="assets space-y-3"></div>
      ${agent.policy.time_window
        ? `<div class="text-xs text-secondary flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">schedule</span>
           Permitted window: UTC minute ${agent.policy.time_window.start_minute} to ${agent.policy.time_window.end_minute}
           ${agent.policy.time_window.start_minute > agent.policy.time_window.end_minute ? " (wraps midnight)" : ""}</div>`
        : `<div class="text-xs text-secondary flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">schedule</span>No time restriction</div>`}
    `;

    // Per-asset quota, which is the real shape of the limits.
    const assetsBox = card.querySelector(".assets");
    for (const cp of agent.policy.chains) {
      const chainMeta = CHAINS[cp.chain] ?? { label: cp.chain, symbol: "" };
      const feeInfo = assetInfo("native", cp.chain);
      const head = el("div", "pt-1", `<div class="flex items-baseline justify-between gap-2 flex-wrap">
          <span class="font-medium">${esc(chainMeta.label)}</span>
          <span class="text-xs text-secondary">fee cap ${amountCell(cp.max_fee, feeInfo)}</span>
        </div>`);
      assetsBox.appendChild(head);

      for (const ap of cp.assets) {
        const info = assetInfo(ap.asset, cp.chain);
        const ledger = agent.ledgers.find(
          (l) => l.chain === cp.chain && assetInfo(l.asset, l.chain).key === info.key,
        );
        const spent = ledger ? spentInWindow(ledger.entries, state.now) : 0n;
        const row = el("div", "pl-3 border-l-2 border-surface-container space-y-1");
        row.innerHTML = `
          <div class="flex items-baseline justify-between gap-3 flex-wrap">
            <span class="text-sm">${esc(info.label)}${info.token ? ` <span class="mono text-[11px] text-secondary">${esc(short(info.token, 8))}</span>` : ""}</span>
            <span class="mono text-xs">${amountCell(spent.toString(), info)} / ${amountCell(ap.max_per_24h, info)}</span>
          </div>
          ${quotaBar(spent, BigInt(ap.max_per_24h))}
          <div class="text-xs text-secondary">
            per-request cap ${amountCell(ap.max_per_request, info)} ·
            ${ap.allowed_destinations.length === 0
              ? `<span class="text-amber-700 font-medium">no destinations allowlisted — this asset cannot be sent anywhere</span>`
              : `${ap.allowed_destinations.length} allowlisted destination${ap.allowed_destinations.length === 1 ? "" : "s"}`}
          </div>
          ${ap.allowed_destinations.length
            ? `<div class="mono text-[11px] text-secondary break-all">${ap.allowed_destinations.map(esc).join("<br>")}</div>`
            : ""}`;
        assetsBox.appendChild(row);
      }
    }

    // Derived addresses, fetched from the MPC signer.
    const addrBox = card.querySelector(".addresses");
    addrBox.innerHTML = `<div class="text-xs text-secondary">Resolving derived addresses…</div>`;
    list.appendChild(card);

    (async () => {
      const parts = [];
      for (const cp of agent.policy.chains) {
        try {
          const path = await view(state.account, "get_derivation_path", {
            owner: k.owner,
            public_key: agent.public_key,
            chain: cp.chain,
          });
          const d = await derivedAddress(state.account, path, cp.chain);
          const meta = CHAINS[cp.chain] ?? {};
          const needsKey = cp.chain === "bitcoin_testnet4";
          const registered = needsKey && agent.btc_pubkey === d.compressed;
          parts.push(`<div class="p-3 rounded-lg bg-surface-container-low space-y-1">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <span class="text-xs uppercase tracking-wider text-secondary font-semibold">${esc(meta.label ?? cp.chain)} address</span>
              ${needsKey
                ? registered
                  ? `<span class="text-xs text-emerald-700 inline-flex items-center gap-1"><span class="material-symbols-outlined text-[13px]">check_circle</span>change key registered</span>`
                  : `<span class="text-xs text-error inline-flex items-center gap-1"><span class="material-symbols-outlined text-[13px]">error</span>change key NOT registered — spends are refused</span>`
                : ""}
            </div>
            <div class="mono text-xs break-all">${esc(d.address)}</div>
            <div class="mono text-[10px] text-secondary break-all">path ${esc(path)}</div>
          </div>`);
        } catch (err) {
          parts.push(`<div class="p-3 rounded-lg bg-surface-container-low text-xs text-error">
            Could not derive the ${esc(cp.chain)} address: ${esc(err.message)}</div>`);
        }
      }
      addrBox.innerHTML = parts.join("");
    })();
  }
}

function renderActivity() {
  const rows = state.requests.map((r) => {
    const info = assetInfo(r.asset, r.chain);
    const feeInfo = assetInfo("native", r.chain);
    const meta = CHAINS[r.chain] ?? {};
    return `<tr class="hover:bg-surface-container-low/60 transition-colors align-top">
      <td class="px-4 py-3 mono text-xs">#${r.id}</td>
      <td class="px-4 py-3">${statusPill(r.status, r.signature?.mock)}</td>
      <td class="px-4 py-3 text-xs">
        <div class="font-medium">${esc(meta.label ?? r.chain)}</div>
        <div class="text-secondary">${esc(info.label)}</div>
      </td>
      <td class="px-4 py-3 mono text-xs">${amountCell(r.amount, info)}</td>
      <td class="px-4 py-3 mono text-xs break-all max-w-[220px]">${esc(r.destination)}</td>
      <td class="px-4 py-3 mono text-xs">${amountCell(r.fee, feeInfo)}</td>
      <td class="px-4 py-3 text-xs max-w-[380px]">
        ${r.refusal
          ? `<div class="mono text-error font-medium">${esc(r.refusal.code)}</div>
             <div class="text-secondary">${esc(r.refusal.message)}</div>
             ${r.refusal.limit ? `<div class="text-secondary mono text-[11px] mt-0.5">limit ${esc(r.refusal.limit)} · observed ${esc(r.refusal.observed)}</div>` : ""}`
          : r.signature
            ? `<div class="text-secondary">signature recorded${r.signature.mock ? " <strong class='text-error'>(mock — not real MPC output)</strong>" : ""}</div>
               <div class="mono text-[10px] text-secondary break-all">payload ${esc(short(r.payload_hex ?? "", 12))}</div>`
            : `<div class="text-secondary">${esc(r.failure_reason ?? "—")}</div>`}
      </td>
    </tr>`;
  });

  $("#activity-table").innerHTML = state.requests.length
    ? `<div class="overflow-x-auto"><table class="w-full text-left border-collapse">
        <thead><tr class="bg-surface-container-low text-secondary text-xs uppercase tracking-wider h-10">
          <th class="px-4 font-semibold">#</th><th class="px-4 font-semibold">Status</th>
          <th class="px-4 font-semibold">Chain / asset</th><th class="px-4 font-semibold">Amount</th>
          <th class="px-4 font-semibold">Destination</th><th class="px-4 font-semibold">Fee (derived)</th>
          <th class="px-4 font-semibold">Outcome detail</th>
        </tr></thead>
        <tbody class="divide-y divide-surface-container">${rows.join("")}</tbody></table></div>
       <div class="px-4 py-3 bg-surface-container-low/50 text-xs text-secondary">
         ${state.requests.length} request${state.requests.length === 1 ? "" : "s"} retained on contract.
         Older activity is reconstructible from the NEP-297 event stream.
       </div>`
    : `<div class="p-5 text-secondary">No requests recorded yet.</div>`;
}

function renderActions() {
  const acc = state.account;
  const owner = state.keyring?.owner ?? acc;
  const agent = state.keyring?.agents?.[0];
  const cmd = (title, why, body) => `<div class="p-4 rounded-xl bg-surface-container-lowest shadow-sm space-y-2">
      <div class="font-semibold">${esc(title)}</div>
      <p class="text-secondary text-xs">${why}</p>
      <pre class="p-3 bg-[#0c111d] text-slate-200 rounded-lg overflow-x-auto mono text-[11px] leading-relaxed">${esc(body)}</pre>
    </div>`;

  const sign = `  --prepaid-gas '50 TGas' --attached-deposit '0 NEAR' \\\n  sign-as ${owner} network-config testnet sign-with-legacy-keychain send`;

  $("#actions-list").innerHTML = [
    cmd("Disable an agent (kill switch)",
      "Takes effect immediately: every subsequent request is refused with <span class='mono'>agent_disabled</span>, before any signing.",
      `near contract call-function as-transaction ${acc} set_agent_enabled \\\n  json-args '{"public_key":"${agent?.public_key ?? "<agent public key>"}","enabled":false}' \\\n${sign}`),
    cmd("Revoke an agent",
      "Removes the agent and its own spend ledger. The keyring-wide ledger is deliberately untouched, so revoking and re-registering cannot reset an owner-wide budget.",
      `near contract call-function as-transaction ${acc} revoke_agent \\\n  json-args '{"public_key":"${agent?.public_key ?? "<agent public key>"}"}' \\\n${sign}`),
    cmd("Set the owner-wide 24h budget",
      "Bounds the total across every agent. Without it, N agents each capped at C expose you to N&times;C.",
      `near contract call-function as-transaction ${acc} set_aggregate_budget \\\n  json-args '{"budget":{"caps":[{"chain":"base_sepolia","asset":"native","max_per_24h":"1500000000000"}]}}' \\\n${sign}`),
    cmd("Register an agent",
      "Caps are per asset, because amounts are in each asset's own base units. An empty destination list permits nobody.",
      `near contract call-function as-transaction ${acc} register_agent \\\n  json-args '{\n    "public_key": "<agent public key>",\n    "label": "agent-two",\n    "policy": {\n      "chains": [{\n        "chain": "base_sepolia",\n        "max_fee": "100000000000000",\n        "assets": [{\n          "asset": "native",\n          "max_per_request": "1000000000000",\n          "max_per_24h": "5000000000000",\n          "allowed_destinations": ["0x1111111111111111111111111111111111111111"]\n        }]\n      }],\n      "time_window": null\n    }\n  }' \\\n${sign}`),
    cmd("Register the Bitcoin change key",
      "Required before Bitcoin spends: the contract builds the change output itself and cannot derive this key synchronously. Derive it with the SDK rather than transcribing it — a wrong value sends change somewhere you do not control.",
      `node -e "import('./packages/sdk/dist/index.js').then(async m => {\n  const k = await m.deriveBitcoinKey({\n    path: 'keyring-v1,${owner},${agent?.label ?? "agent-one"},bitcoin-testnet4',\n    predecessor: '${acc}' });\n  console.log(k.compressedPubkey, k.address);\n})"`),
  ].join("");
}

// ───────────────────────────────── load + tabs

async function load(account) {
  state.account = account;
  state.now = Date.now();
  $("#banner").hidden = true;
  $("#side-contract").textContent = account;

  const keyring = await view(account, "get_keyring", { owner: account });
  if (!keyring) {
    throw new Error(
      `no keyring registered for ${account}. If this account owns a Keyring under a different owner id, load that instead.`,
    );
  }
  state.keyring = keyring;
  state.signer = await view(account, "get_signer_backend");
  state.requests = await view(account, "get_history", { owner: account, limit: 100 });
  $("#side-signer").textContent =
    typeof state.signer === "string" ? "mock signer" : state.signer.mpc.contract_id;

  if (typeof state.signer === "string" || state.requests.some((r) => r.signature?.mock)) {
    banner("warn",
      "<strong>This deployment uses the mock signer.</strong> Signatures shown here are deterministic stand-ins and are not valid on any chain.");
  }

  renderOverview();
  renderActivity();
  renderActions();
  await renderAgents();
}

function showTab(name) {
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.className = `tab flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
      on ? "bg-slate-800 text-slate-100 font-semibold border-l-2 border-emerald-400 pl-[6px]" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
    }`;
  });
  $("#crumb").textContent = { overview: "Overview", agents: "Agents", activity: "Activity", actions: "Owner Actions" }[name];
  location.hash = name;
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", (e) => {
    e.preventDefault();
    showTab(t.dataset.tab);
  }),
);

async function go() {
  const account = $("#owner-input").value.trim();
  if (!account) return;
  $("#load-btn").disabled = true;
  try {
    await load(account);
  } catch (err) {
    banner("error", `<strong>Could not load ${esc(account)}.</strong> ${esc(err.message)}`);
    $("#tiles").innerHTML = "";
    $("#agents-list").innerHTML = "";
    $("#activity-table").innerHTML = "";
  } finally {
    $("#load-btn").disabled = false;
  }
}

$("#load-btn").addEventListener("click", go);
$("#owner-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") go();
});

const params = new URLSearchParams(location.search);
$("#owner-input").value = params.get("account") ?? DEFAULT_ACCOUNT;
showTab(location.hash.slice(1) || "overview");
go();
