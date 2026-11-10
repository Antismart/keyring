/**
 * Renders every view against a live deployment and asserts what must appear.
 *
 * The views are pure string builders, so they can be exercised without a
 * browser. This catches the failure that matters most for a console — showing
 * the wrong figure, or showing invented data — which a type check cannot.
 *
 *   pnpm --filter @keyring/dashboard verify [account]
 */
import { view } from "./rpc";
import type { Keyring, SignerBackend, TransferRequest } from "./types";
import { activityView } from "./views/activity";
import { agentsView } from "./views/agents";
import { overview } from "./views/overview";
import { ownerView } from "./views/owner";

const ACC = process.argv[2] ?? "keyring-gated-1794298589.testnet";
const keyring = await view<Keyring>(ACC, "get_keyring", { owner: ACC });
const signer = await view<SignerBackend>(ACC, "get_signer_backend");
const requests = await view<TransferRequest[]>(ACC, "get_history", { owner: ACC, limit: 100 });

const html = {
  overview: overview(keyring, requests, signer, Date.now()),
  agents: agentsView(keyring),
  activity: activityView(requests),
  owner: ownerView(keyring, keyring.owner),
};

const checks: Array<[string, boolean]> = [
  ["overview renders agent count", html.overview.includes("of 1 enabled")],
  ["overview shows the live MPC backend", html.overview.includes("Live MPC")],
  ["overview shows the owner-wide budget", html.overview.includes("Owner-wide budget")],
  ["agents shows the agent label", html.agents.includes("agent-one")],
  ["agents shows per-asset USDC row", html.agents.includes("USDC")],
  ["agents shows a Bitcoin fee cap", html.agents.includes("Bitcoin testnet4")],
  ["agents exposes exact integers", html.agents.includes('class="exact mono"')],
  ["activity lists requests", html.activity.includes("#1")],
  ["activity shows a refusal code", /owner_daily_cap_exceeded|destination_not_allowed/.test(html.activity)],
  ["activity marks no mock signatures", !html.activity.includes("mock signature")],
  ["owner view recognises the owner", !html.owner.includes("different account")],
  ["owner view warns about private keys", html.owner.includes("Never paste a private key")],
  ["no fabricated agents", !/Treasury-Optimizer|Arb-Executor/.test(Object.values(html).join(""))],
  ["no NEAR-denominated spend", !/\d NEAR\b/.test(Object.values(html).join(""))],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}`);
}
console.log(`\n${failed === 0 ? "all render checks passed" : `${failed} FAILED`} (${checks.length - failed}/${checks.length})`);
process.exit(failed === 0 ? 0 : 1);
