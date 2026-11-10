/** Amount, asset and address formatting. */

import type { Asset } from "@keyring/sdk";

import { CHAINS, ROLLING_WINDOW_MS, TOKENS } from "./config";

export interface AssetInfo {
  /** Stable key for matching a policy entry to its ledger. */
  key: string;
  label: string;
  decimals: number;
  /** Name of the smallest unit, for exact figures. */
  unit: string;
  token?: string;
}

/** Describes an asset for display. */
export function assetInfo(asset: Asset, chain: string): AssetInfo {
  if (asset === "native") {
    const c = CHAINS[chain];
    return {
      key: "native",
      label: c?.symbol ?? "native",
      decimals: c?.decimals ?? 0,
      unit: c?.unit ?? "base units",
    };
  }
  const token = asset.erc20.token.toLowerCase();
  const known = TOKENS[token];
  return {
    key: `erc20:${token}`,
    label: known?.symbol ?? `token ${truncate(token, 6)}`,
    decimals: known?.decimals ?? 0,
    unit: "token base units",
    token,
  };
}

/** Formats an integer base-unit value for reading. */
export function amount(raw: string | bigint, info: AssetInfo): string {
  const v = BigInt(raw);
  if (info.decimals === 0) return `${v.toLocaleString()} ${info.unit}`;
  const d = 10n ** BigInt(info.decimals);
  const whole = v / d;
  const frac = (v % d).toString().padStart(info.decimals, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ${info.label}`;
}

/** The exact integer, for a tooltip. Policy is enforced on this, not the decimal. */
export function exact(raw: string | bigint, info: AssetInfo): string {
  return `${BigInt(raw).toString()} ${info.unit}`;
}

export function truncate(s: string | null | undefined, n = 10): string {
  if (!s) return "—";
  return s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s;
}

/**
 * Sum of ledger entries still inside the rolling window.
 *
 * Recomputed here rather than read from the contract, with the same half-open
 * boundary, so the figure shown is current rather than a stored snapshot.
 */
export function spentInWindow(
  entries: Array<{ at_ms: number; amount: string }>,
  nowMs: number,
): bigint {
  const cutoff = nowMs - ROLLING_WINDOW_MS;
  return entries
    .filter((e) => e.at_ms > cutoff)
    .reduce((acc, e) => acc + BigInt(e.amount), 0n);
}

/** Percentage of a cap committed, as a number for bar widths. */
export function percentOf(spent: bigint, cap: bigint): number {
  if (cap === 0n) return 0;
  return Number((spent * 10_000n) / cap) / 100;
}

export function minuteOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const AMP = /[&<>"']/g;
const ENTITIES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
/** Escapes text for interpolation into markup. */
export function esc(s: unknown): string {
  return String(s ?? "").replace(AMP, (c) => ENTITIES[c] ?? c);
}
