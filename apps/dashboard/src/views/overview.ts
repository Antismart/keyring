/** Overview: the figures an owner checks first. */

import { CHAINS } from "../config";
import { assetInfo, esc, spentInWindow } from "../format";
import type { AggregateBudget, AssetLedger, Keyring, SignerBackend, TransferRequest } from "../types";
import { quota } from "./quota";

function tile(label: string, value: string, sub: string | null, tone = ""): string {
  return `<div class="card p-4">
    <div class="label">${esc(label)}</div>
    <div class="text-xl font-semibold mt-1 ${tone}">${value}</div>
    ${sub ? `<div class="text-xs muted mt-0.5">${sub}</div>` : ""}
  </div>`;
}

export function overview(
  keyring: Keyring,
  requests: TransferRequest[],
  signer: SignerBackend,
  now: number,
): string {
  const enabled = keyring.agents.filter((a) => a.enabled).length;
  const refused = requests.filter((r) => r.status === "refused").length;
  const signed = requests.filter((r) => r.status === "signed").length;
  const anyMock = requests.some((r) => r.signature?.mock) || signer === "mock";

  const tiles = [
    tile(
      "Agents",
      `${enabled} <span class="text-sm muted font-normal">of ${keyring.agents.length} enabled</span>`,
      keyring.agents.length === enabled ? "none disabled" : `${keyring.agents.length - enabled} disabled`,
    ),
    tile("Requests", String(requests.length), `${signed} signed · ${refused} refused`),
    tile(
      "Refused before signing",
      requests.length ? `${Math.round((refused / requests.length) * 100)}%` : "—",
      "policy denied, nothing signed",
    ),
    tile(
      "Signing backend",
      anyMock ? "Mock" : "Live MPC",
      signer === "mock" ? "stand-in signatures" : esc(signer.mpc.contract_id),
      anyMock ? "text-[var(--danger)]" : "text-[var(--ok)]",
    ),
  ].join("");

  return `
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Overview</h1>
      <p class="muted mt-1 max-w-3xl">Read live from the Keyring contract. Every figure is computed from
      contract state — there are no cached or estimated values on this page.</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">${tiles}</div>
    ${budget(keyring.aggregate, keyring.ledgers, now)}
    <div class="card p-5">
      <h2 class="font-semibold">Where enforcement happens</h2>
      <p class="muted mt-1 max-w-4xl">Policy lives in a NEAR smart contract. An agent asks for a transfer;
      the contract evaluates it and only then builds the transaction itself and calls NEAR Chain
      Signatures. Execution settles on the destination chain — Base Sepolia or Bitcoin testnet4 — never on
      NEAR. The agent holds no key and never supplies calldata, a preimage or a hash.</p>
    </div>`;
}

function budget(aggregate: AggregateBudget, ledgers: AssetLedger[], now: number): string {
  if (!aggregate?.caps?.length) {
    return `<div class="card p-5">
      <h2 class="font-semibold">Owner-wide budget</h2>
      <p class="muted mt-1 max-w-3xl">No keyring-wide cap is set, so each agent is bounded only by its own
      limits. With N agents each capped at C, total exposure is N&times;C. Set one from
      <strong>Owner actions</strong>.</p>
    </div>`;
  }
  const rows = aggregate.caps
    .map((cap) => {
      const info = assetInfo(cap.asset, cap.chain);
      const ledger = ledgers.find(
        (l) => l.chain === cap.chain && assetInfo(l.asset, l.chain).key === info.key,
      );
      const spent = ledger ? spentInWindow(ledger.entries, now) : 0n;
      return `<div>
        <div class="text-sm font-medium">${esc(CHAINS[cap.chain]?.label ?? cap.chain)} · ${esc(info.label)}</div>
        ${quota(spent, BigInt(cap.max_per_24h), info)}
      </div>`;
    })
    .join("");
  return `<div class="card p-5">
    <h2 class="font-semibold">Owner-wide budget</h2>
    <p class="muted mt-1 max-w-3xl">Caps the total across <strong>every</strong> agent, which per-agent
    limits cannot do.</p>
    <div class="grid gap-4 mt-4 sm:grid-cols-2">${rows}</div>
  </div>`;
}
