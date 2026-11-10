/** The quota bar, shared by the overview and the agent cards. */

import { amount, esc, exact, percentOf, type AssetInfo } from "../format";

export function quota(spent: bigint, cap: bigint, info: AssetInfo): string {
  const pct = percentOf(spent, cap);
  const tone = pct >= 100 ? "over" : pct >= 90 ? "near" : "";
  const figure = (v: bigint) =>
    `<span class="exact" title="${esc(exact(v, info))}">${esc(amount(v, info))}</span>`;
  return `
    <div class="flex items-baseline justify-between gap-3 flex-wrap mt-1">
      <span class="mono text-xs">${figure(spent)} <span class="faint">of</span> ${figure(cap)}</span>
      <span class="text-xs ${pct >= 90 ? "font-semibold" : "muted"}">${pct.toFixed(pct < 10 ? 1 : 0)}%</span>
    </div>
    <div class="bar ${tone} mt-1"><span style="width:${Math.min(100, pct)}%"></span></div>`;
}
