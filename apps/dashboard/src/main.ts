/**
 * Keyring owner console.
 *
 * Reads live contract state over JSON-RPC and renders it. Two rules hold
 * throughout:
 *
 *  1. **Nothing is invented.** Every figure comes from contract state. A
 *     console that shows plausible-looking fiction is worse than none, because
 *     a reader cannot tell it apart from one that works.
 *  2. **It holds no key.** Owner actions are signed in the owner's own wallet.
 *     The contract is the authority — a call signed by anyone else is rejected
 *     on chain regardless of what this page sends.
 */

import "./styles.css";

import { CHAINS, DEFAULT_ACCOUNT } from "./config";
import { derivedAddress } from "./derive";
import { esc } from "./format";
import { view } from "./rpc";
import type { Keyring, SignerBackend, TransferRequest } from "./types";
import { activityView } from "./views/activity";
import { agentsView, hydrateAddresses } from "./views/agents";
import { overview } from "./views/overview";
import { ownerView } from "./views/owner";
/**
 * The wallet layer is loaded on demand.
 *
 * It pulls in wallet-selector and the NEAR libraries beneath it, which is most
 * of the bundle. Reading a keyring needs none of that, so a visitor who only
 * looks at state never downloads it; it arrives when they connect, or on load
 * if a previous session is remembered.
 */
type WalletModule = typeof import("./wallet");
let walletModule: WalletModule | null = null;
async function wallet(): Promise<WalletModule> {
  walletModule ??= await import("./wallet");
  return walletModule;
}

/** Whether wallet-selector remembers a session worth restoring. */
function hasWalletSession(): boolean {
  try {
    return (
      localStorage.getItem("near-wallet-selector:selectedWalletId") !== null ||
      localStorage.getItem("near-wallet-selector:selectedWalletId:pending") !== null
    );
  } catch {
    // Blocked or unavailable storage simply means no remembered session.
    return false;
  }
}

type Tab = "overview" | "agents" | "activity" | "owner";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "agents", label: "Agents" },
  { id: "activity", label: "Activity" },
  { id: "owner", label: "Owner actions" },
];

interface State {
  account: string;
  keyring: Keyring | null;
  requests: TransferRequest[];
  signer: SignerBackend;
  connected: string | null;
  walletName: string | null;
  tab: Tab;
  error: string | null;
  loading: boolean;
}

const state: State = {
  account: new URLSearchParams(location.search).get("account")?.trim() || DEFAULT_ACCOUNT,
  keyring: null,
  requests: [],
  signer: "mock",
  connected: null,
  walletName: null,
  tab: (location.hash.slice(1) as Tab) || "overview",
  error: null,
  loading: true,
};

const app = document.getElementById("app")!;

function shell(body: string): string {
  const nav = TABS.map(
    (t) =>
      `<a href="#${t.id}" data-tab="${t.id}" ${t.id === state.tab ? 'aria-current="page"' : ""}>${esc(
        t.label,
      )}</a>`,
  ).join("");

  const wallet = state.connected
    ? `<span class="pill pill-ok">${esc(state.connected)}</span>
       <button class="btn" id="wallet-btn" data-mode="out">Disconnect</button>`
    : `<button class="btn btn-primary" id="wallet-btn" data-mode="in">Connect wallet</button>`;

  return `
  <aside class="rail fixed left-0 top-0 h-screen w-[232px] z-40 flex flex-col">
    <div class="h-14 px-4 flex items-center justify-between" style="border-bottom:1px solid var(--rail-line)">
      <span class="font-semibold tracking-wide text-slate-100">KEYRING</span>
      <span class="pill" style="background:#78350f33;color:#fbbf24">testnet</span>
    </div>
    <nav class="flex-1 p-2 grid gap-1 content-start">${nav}</nav>
    <div class="p-3 text-[11px]" style="border-top:1px solid var(--rail-line);color:#64748b">
      <div class="label" style="color:#64748b">Contract</div>
      <div class="mono break-all" style="color:#cbd5e1">${esc(state.account)}</div>
      <div class="mono break-all mt-1">${
        state.signer === "mock" ? "mock signer" : esc(state.signer.mpc.contract_id)
      }</div>
    </div>
  </aside>

  <div class="pl-0 md:pl-[232px] min-h-screen flex flex-col">
    <header class="sticky top-0 z-30 flex flex-wrap items-center gap-2 px-4 py-3"
            style="background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--surface-line)">
      <input class="field mono flex-1 min-w-[220px] max-w-[320px]" id="account-input"
             value="${esc(state.account)}" placeholder="keyring account" aria-label="Keyring account" />
      <button class="btn" id="load-btn" ${state.loading ? "disabled" : ""}>
        ${state.loading ? "Loading…" : "Load"}
      </button>
      <div class="flex-1"></div>
      ${wallet}
    </header>

    <main class="flex-1 grid gap-5 w-full max-w-[1500px] mx-auto"
          style="padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:24px">
      ${state.error ? `<div class="card p-4" style="background:var(--danger-soft);border-color:color-mix(in srgb,var(--danger) 40%,transparent)">
        <div class="font-semibold text-[var(--danger)]">Could not load ${esc(state.account)}</div>
        <div class="text-xs mt-1">${esc(state.error)}</div></div>` : ""}
      ${body}
    </main>

    <footer class="px-4 py-4 text-xs faint" style="border-top:1px solid var(--surface-line)">
      Keyring — policy-enforced wallet infrastructure for AI agents. Testnet only; nothing here has been audited.
    </footer>
  </div>`;
}

function render(): void {
  let body = "";
  if (state.loading && !state.keyring) {
    body = `<div class="card p-5 muted">Reading contract state…</div>`;
  } else if (!state.keyring) {
    body = `<div class="card p-5 muted">No keyring loaded.</div>`;
  } else if (state.tab === "overview") {
    body = overview(state.keyring, state.requests, state.signer, Date.now());
  } else if (state.tab === "agents") {
    body = agentsView(state.keyring);
  } else if (state.tab === "activity") {
    body = activityView(state.requests);
  } else {
    body = ownerView(state.keyring, state.connected);
  }

  app.innerHTML = shell(body);
  wire();
  if (state.tab === "agents" && state.keyring) {
    void hydrateAddresses(state.account, state.keyring);
  }
}

function setTab(tab: Tab): void {
  state.tab = tab;
  location.hash = tab;
  render();
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    const keyring = await view<Keyring | null>(state.account, "get_keyring", { owner: state.account });
    if (!keyring) {
      throw new Error(
        `no keyring is registered for this account. If it owns one under a different owner id, load that instead.`,
      );
    }
    state.keyring = keyring;
    state.signer = await view<SignerBackend>(state.account, "get_signer_backend");
    state.requests = await view<TransferRequest[]>(state.account, "get_history", {
      owner: state.account,
      limit: 100,
    });
    if (hasWalletSession()) await restoreWallet();
  } catch (err) {
    state.keyring = null;
    state.error = (err as Error).message;
  } finally {
    state.loading = false;
    render();
  }
}

/** Restores a remembered wallet session and follows later changes. */
async function restoreWallet(): Promise<void> {
  const w = await wallet();
  const current = await w.walletState(state.account);
  state.connected = current.accountId;
  state.walletName = current.walletName;
  void w.onAccountChange(state.account, async () => {
    const next = await w.walletState(state.account);
    if (next.accountId !== state.connected) {
      state.connected = next.accountId;
      render();
    }
  });
}

function result(kind: "ok" | "err", html: string): void {
  const box = document.getElementById("owner-result");
  if (!box) return;
  const colour = kind === "ok" ? "var(--ok)" : "var(--danger)";
  box.innerHTML = `<div class="card p-4" style="border-color:color-mix(in srgb,${colour} 40%,transparent)">
    <div class="font-semibold" style="color:${colour}">${kind === "ok" ? "Submitted" : "Failed"}</div>
    <div class="text-xs mt-1">${html}</div></div>`;
}

async function submitCall(method: string, args: Record<string, unknown>): Promise<void> {
  try {
    const { txHash } = await (await wallet()).ownerCall(state.account, method, args);
    result(
      "ok",
      `<span class="mono">${esc(method)}</span> sent.${
        txHash ? ` Transaction <span class="mono">${esc(txHash)}</span>.` : ""
      } Reload to see the new state.`,
    );
    await load();
  } catch (err) {
    result("err", esc((err as Error).message));
  }
}

function wire(): void {
  document.querySelectorAll<HTMLAnchorElement>("[data-tab]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      setTab(a.dataset.tab as Tab);
    }),
  );

  document.getElementById("load-btn")?.addEventListener("click", () => {
    const input = document.getElementById("account-input") as HTMLInputElement | null;
    const next = input?.value.trim().replace(/\.$/, "");
    if (!next) return;
    state.account = next;
    const url = new URL(location.href);
    url.searchParams.set("account", next);
    history.replaceState(null, "", url);
    void load();
  });

  document.getElementById("account-input")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") document.getElementById("load-btn")?.click();
  });

  const walletBtn = document.getElementById("wallet-btn");
  walletBtn?.addEventListener("click", async () => {
    try {
      const w = await wallet();
      if (walletBtn.getAttribute("data-mode") === "in") {
        await w.connect(state.account);
        // A redirect wallet navigates away here; an injected one returns, so
        // pick up the new account either way.
        await restoreWallet();
        render();
      } else {
        await w.disconnect(state.account);
        state.connected = null;
        render();
      }
    } catch (err) {
      result("err", esc((err as Error).message));
    }
  });

  // Agent card buttons.
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.key!;
      const action = btn.dataset.action!;
      if (!state.connected) {
        setTab("owner");
        return;
      }
      if (action === "revoke") {
        // The viewer never shows confirm(), so the confirmation is in the page.
        btn.textContent = "Click again to revoke";
        btn.dataset.action = "revoke-confirm";
        return;
      }
      if (action === "revoke-confirm") void submitCall("revoke_agent", { public_key: key });
      if (action === "disable") void submitCall("set_agent_enabled", { public_key: key, enabled: false });
      if (action === "enable") void submitCall("set_agent_enabled", { public_key: key, enabled: true });
    }),
  );

  // Owner forms.
  document.querySelectorAll<HTMLFormElement>("[data-form]").forEach((form) =>
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const kind = form.dataset.form;
      if (kind === "budget") {
        void submitCall("set_aggregate_budget", {
          budget: {
            caps: [
              {
                chain: String(f.get("chain")),
                asset: "native",
                max_per_24h: String(f.get("cap")).trim(),
              },
            ],
          },
        });
      } else if (kind === "btckey") {
        void submitCall("set_agent_btc_pubkey", {
          public_key: String(f.get("key")),
          compressed_hex: String(f.get("compressed")).trim(),
        });
      } else if (kind === "agent") {
        const chain = String(f.get("chain"));
        const destinations = String(f.get("destinations") ?? "")
          .split("\n")
          .map((d) => d.trim())
          .filter(Boolean);
        void submitCall("register_agent", {
          public_key: String(f.get("public_key")).trim(),
          label: String(f.get("label")).trim(),
          policy: {
            chains: [
              {
                chain,
                max_fee: String(f.get("max_fee")).trim(),
                assets: [
                  {
                    asset: "native",
                    max_per_request: String(f.get("max_per_request")).trim(),
                    max_per_24h: String(f.get("max_per_24h")).trim(),
                    allowed_destinations: destinations,
                  },
                ],
              },
            ],
            time_window: null,
          },
        });
      }
    }),
  );

  // Prefill the Bitcoin key field from the signer, so nobody transcribes it.
  const btcForm = document.querySelector<HTMLFormElement>('[data-form="btckey"]');
  if (btcForm && state.keyring) {
    const fill = async () => {
      const select = btcForm.elements.namedItem("key") as HTMLSelectElement | null;
      const field = btcForm.elements.namedItem("compressed") as HTMLInputElement | null;
      const agent = state.keyring!.agents.find((a) => a.public_key === select?.value);
      if (!select || !field || !agent) return;
      field.value = "resolving…";
      try {
        const path = `keyring-v1,${state.keyring!.owner},${agent.label},${CHAINS.bitcoin_testnet4!.short}`;
        const d = await derivedAddress(state.account, path, "bitcoin_testnet4");
        field.value = d.compressed ?? "";
      } catch {
        field.value = "";
      }
    };
    btcForm.querySelector('[name="key"]')?.addEventListener("change", () => void fill());
    void fill();
  }
}

window.addEventListener("hashchange", () => {
  const tab = location.hash.slice(1) as Tab;
  if (TABS.some((t) => t.id === tab) && tab !== state.tab) setTab(tab);
});

render();
void load();
