/** Activity: every recorded request, with the rule that refused it. */

import { CHAINS } from "../config";
import { amount, assetInfo, esc, exact, truncate } from "../format";
import type { RequestStatus, TransferRequest } from "../types";

function pill(status: RequestStatus, mock: boolean | undefined): string {
  const map: Record<RequestStatus, [string, string]> = {
    signed: ["pill-ok", mock ? "Signed (mock)" : "Signed"],
    refused: ["pill-danger", "Refused"],
    failed: ["pill-danger", "Failed"],
    signing: ["pill-warn", "Signing"],
    created: ["pill-neutral", "Created"],
  };
  const [cls, label] = map[status] ?? ["pill-neutral", status];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

export function activityView(requests: TransferRequest[]): string {
  const heading = `<div>
    <h1 class="text-2xl font-semibold tracking-tight">Activity</h1>
    <p class="muted mt-1 max-w-3xl">A refusal is a result, not an error. Each carries a stable code, the
    rule that produced it, the configured limit and the observed value.</p>
  </div>`;

  if (requests.length === 0) {
    return `${heading}<div class="card p-5 muted">No requests recorded yet.</div>`;
  }

  const rows = requests
    .map((r) => {
      const info = assetInfo(r.asset, r.chain);
      const feeInfo = assetInfo("native", r.chain);
      const detail = r.refusal
        ? `<div class="mono text-xs text-[var(--danger)] font-semibold">${esc(r.refusal.code)}</div>
           <div class="text-xs muted mt-0.5">${esc(r.refusal.message)}</div>
           ${
             r.refusal.limit
               ? `<div class="mono text-[11px] faint mt-0.5">limit ${esc(r.refusal.limit)} · observed ${esc(
                   r.refusal.observed,
                 )}</div>`
               : ""
           }`
        : r.signature
          ? `<div class="text-xs muted">${
              r.signature.mock
                ? `<span class="text-[var(--danger)] font-semibold">mock signature</span> — not valid on any chain`
                : "signature recorded by the MPC network"
            }</div>
            <div class="mono text-[11px] faint mt-0.5">payload ${esc(truncate(r.payload_hex, 12))}</div>`
          : `<div class="text-xs muted">${esc(r.failure_reason ?? "—")}</div>`;

      return `<tr>
        <td class="mono text-xs">#${r.id}</td>
        <td>${pill(r.status, r.signature?.mock)}</td>
        <td class="text-xs"><div class="font-medium">${esc(CHAINS[r.chain]?.label ?? r.chain)}</div>
          <div class="muted">${esc(info.label)}</div></td>
        <td class="mono text-xs"><span class="exact" title="${esc(exact(r.amount, info))}">${esc(
          amount(r.amount, info),
        )}</span></td>
        <td class="mono text-xs break-all" style="max-width:220px">${esc(r.destination)}</td>
        <td class="mono text-xs"><span class="exact" title="${esc(exact(r.fee, feeInfo))}">${esc(
          amount(r.fee, feeInfo),
        )}</span></td>
        <td style="max-width:360px">${detail}</td>
      </tr>`;
    })
    .join("");

  return `${heading}
    <div class="card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="data">
          <thead><tr>
            <th>#</th><th>Status</th><th>Chain / asset</th><th>Amount</th>
            <th>Destination</th><th>Fee (derived)</th><th>Outcome</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="sunken px-4 py-3 text-xs muted">
        ${requests.length} request${requests.length === 1 ? "" : "s"} retained on contract. Older activity
        is reconstructible from the NEP-297 event stream.
      </div>
    </div>`;
}
