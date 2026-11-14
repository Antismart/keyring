/**
 * Record the Keyring walkthrough.
 *
 *   node scripts/narrate.mjs demo            # voice clips + their durations
 *   node scripts/record-demo.mjs <url> demo  # the picture, cut to those clips
 *   node scripts/mix-demo.mjs demo           # one MP4 with the voice on it
 *
 * The console is driven rather than acted: a synthetic cursor, a spotlight on
 * whatever is being discussed, and one caption per beat. Each beat is held for
 * exactly as long as its narration clip runs, so the voice track lands on the
 * picture without anyone timing it by ear.
 *
 * Two things in the recording are produced by the run that made it, not quoted
 * from a previous one: every figure in the console is read from the deployed
 * contract, and the verifier panel is the live output of
 * scripts/verify-signature.mjs.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { PAD_MS, byId } from "./demo-script.mjs";

const run = promisify(execFile);
const TARGET =
  process.argv[2] ?? "http://localhost:8787/?account=keyring-gated-1794298589.testnet";
const OUT = path.resolve(process.argv[3] ?? "demo");
const SIZE = { width: 1440, height: 900 };
const ACCOUNT = new URL(TARGET).searchParams.get("account") ?? "keyring-gated-1794298589.testnet";
const VERIFY_REQUEST = process.env.DEMO_VERIFY_REQUEST ?? "7";

await fs.mkdir(OUT, { recursive: true });

// Beat lengths come from the synthesised clips when they exist. Without them
// the capture still runs, on a readable-aloud estimate, so the picture can be
// shot on a machine with no speech synthesiser.
let durations = {};
try {
  durations = JSON.parse(await fs.readFile(path.join(OUT, "voice", "durations.json"), "utf8"))
    .durations;
} catch {
  console.log("no voice/durations.json — holding each beat on a reading estimate");
}
const holdFor = (line) =>
  (durations[line.id] ?? Math.max(2500, (line.say.split(/\s+/).length / 172) * 60000)) + PAD_MS;

// The verifier panel shown near the end is this command's real output.
process.stdout.write(`verifying request #${VERIFY_REQUEST} against chain data… `);
const verifyOutput = await run("node", [
  path.join(import.meta.dirname, "verify-signature.mjs"),
  ACCOUNT,
  VERIFY_REQUEST,
])
  .then((r) => r.stdout.trimEnd())
  .catch((e) => `verification could not run:\n${e.message}`);
console.log(verifyOutput.includes("All checks passed") ? "all checks passed" : "see panel");

/** Caption band, cursor, spotlight ring, full-screen card and terminal panel. */
const OVERLAY = () => {
  const install = () => {
    if (document.getElementById("demo-cap")) return;
    const style = document.createElement("style");
    style.textContent = `
      #demo-cap{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);max-width:1060px;
        font:500 20px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#f8fafc;
        background:rgba(2,6,23,.93);border:1px solid rgba(148,163,184,.32);padding:15px 26px;
        border-radius:14px;z-index:2147483646;opacity:0;transition:opacity .35s ease;text-align:center;
        pointer-events:none;box-shadow:0 20px 60px rgba(0,0,0,.55)}
      #demo-cap.on{opacity:1}
      #demo-cur{position:fixed;width:20px;height:20px;border-radius:50%;z-index:2147483647;
        background:rgba(56,189,248,.3);border:2px solid #38bdf8;left:0;top:0;pointer-events:none;
        transform:translate(-50%,-50%);opacity:0;
        transition:left .55s cubic-bezier(.4,0,.2,1),top .55s cubic-bezier(.4,0,.2,1),opacity .3s ease}
      #demo-cur.on{opacity:1}
      #demo-cur.tap{animation:demo-tap .45s ease-out}
      @keyframes demo-tap{from{box-shadow:0 0 0 0 rgba(56,189,248,.55)}
        to{box-shadow:0 0 0 26px rgba(56,189,248,0)}}
      #demo-ring{position:absolute;z-index:2147483645;border-radius:14px;pointer-events:none;opacity:0;
        box-shadow:0 0 0 3px #38bdf8,0 0 0 9999px rgba(2,6,23,.45);
        transition:opacity .35s ease,top .4s ease,left .4s ease,width .4s ease,height .4s ease}
      #demo-ring.on{opacity:1}
      #demo-card{position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;
        justify-items:center;gap:16px;text-align:center;background:#020617;opacity:0;pointer-events:none;
        transition:opacity .55s ease;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;
        padding:0 64px}
      #demo-card.on{opacity:1}
      #demo-card .t{font:600 46px/1.15 ui-sans-serif,system-ui,sans-serif;color:#f8fafc;letter-spacing:-.02em}
      #demo-card .s{font:400 21px/1.65 ui-sans-serif,system-ui,sans-serif;color:#94a3b8;max-width:860px;
        white-space:pre-line}
      #demo-card .m{font:400 15px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace;color:#7dd3fc;
        white-space:pre;text-align:left;background:#0b1220;border:1px solid #1e293b;border-radius:12px;
        padding:18px 24px;margin-top:6px}
      #demo-card .f{font:500 14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#38bdf8;
        letter-spacing:.04em}
      #demo-term{position:fixed;inset:0;z-index:2147483647;background:#020617;opacity:0;
        pointer-events:none;transition:opacity .55s ease;display:grid;place-content:center;
        justify-items:center;gap:18px;padding:0 48px}
      #demo-term.on{opacity:1}
      #demo-term .t{font:600 30px/1.2 ui-sans-serif,system-ui,sans-serif;color:#f8fafc}
      #demo-term pre{font:400 14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd5e1;
        background:#0b1220;border:1px solid #1e293b;border-radius:14px;padding:22px 28px;margin:0;
        max-height:640px;overflow:hidden}
      #demo-term .pass{color:#34d399}
      #demo-term .hd{color:#f8fafc;font-weight:600}
    `;
    document.head.appendChild(style);
    const mk = (id) => {
      const el = document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
      return el;
    };
    const cap = mk("demo-cap");
    const cur = mk("demo-cur");
    const ring = mk("demo-ring");
    const card = mk("demo-card");
    const term = mk("demo-term");
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

    window.__d = {
      cap(text) {
        if (!text) return cap.classList.remove("on");
        cap.textContent = text;
        cap.classList.add("on");
      },
      cursor(x, y) {
        cur.style.left = x + "px";
        cur.style.top = y + "px";
        cur.classList.add("on");
      },
      tap() {
        cur.classList.remove("tap");
        void cur.offsetWidth;
        cur.classList.add("tap");
      },
      ring(b, pad) {
        if (!b) return ring.classList.remove("on");
        ring.style.left = b.x - pad + scrollX + "px";
        ring.style.top = b.y - pad + scrollY + "px";
        ring.style.width = b.width + pad * 2 + "px";
        ring.style.height = b.height + pad * 2 + "px";
        ring.classList.add("on");
      },
      card(title, sub, mono, foot) {
        if (!title && !sub) return card.classList.remove("on");
        card.innerHTML =
          (title ? `<div class="t">${esc(title)}</div>` : "") +
          (sub ? `<div class="s">${esc(sub)}</div>` : "") +
          (mono ? `<div class="m">${esc(mono)}</div>` : "") +
          (foot ? `<div class="f">${esc(foot)}</div>` : "");
        card.classList.add("on");
      },
      term(title, text) {
        if (!title) return term.classList.remove("on");
        const body = esc(text)
          .split("\n")
          .map((l) =>
            /^\s*PASS/.test(l)
              ? `<span class="pass">${l}</span>`
              : /^(Request|Checks|All checks)/.test(l)
                ? `<span class="hd">${l}</span>`
                : l,
          )
          .join("\n");
        term.innerHTML = `<div class="t">${esc(title)}</div><pre>${body}</pre>`;
        term.classList.add("on");
      },
    };
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
};

const browser = await chromium.launch();

// Warm pass. Derived addresses come from the MPC signer and take several
// seconds the first time; they are cached in localStorage, so resolve them in
// a throwaway context and hand that storage to the recording context. Nothing
// in the capture then waits on the signer.
process.stdout.write("warming the derived-address cache… ");
const warm = await browser.newContext({ viewport: SIZE });
const wp = await warm.newPage();
await wp.goto(TARGET, { waitUntil: "networkidle", timeout: 60000 });
await wp
  .waitForFunction(
    () => Object.keys(localStorage).filter((k) => k.startsWith("keyring:derived:")).length >= 2,
    null,
    { timeout: 90000 },
  )
  .catch(() => process.stdout.write("(signer slow — addresses may resolve on camera) "));
const storageState = await warm.storageState();
await warm.close();
console.log("done");

const context = await browser.newContext({
  viewport: SIZE,
  colorScheme: "dark",
  storageState,
  recordVideo: { dir: OUT, size: SIZE },
});
await context.addInitScript(OVERLAY);
const page = await context.newPage();
const t0 = Date.now();
const cues = [];
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));

const wait = (ms) => page.waitForTimeout(ms);
const at = () => Date.now() - t0;

// A still per beat, in cue order. They double as a way to check what the
// capture actually showed without playing it back, and as screenshots.
const FRAMES = path.join(OUT, "frames");
await fs.mkdir(FRAMES, { recursive: true });
let frameNo = 0;
const frame = () =>
  page.screenshot({ path: path.join(FRAMES, `${String(++frameNo).padStart(2, "0")}.png`) });

/** Start a beat: show its caption, record the cue, hold for its clip. */
async function beat(id) {
  const line = byId[id];
  if (!line) throw new Error(`no line "${id}" in demo-script.mjs`);
  const hold = holdFor(line);
  cues.push({ id, at: at(), hold, cap: line.cap, say: line.say });
  await page.evaluate((t) => window.__d.cap(t), line.cap);
  await wait(Math.min(900, hold / 3));
  await frame();
  await wait(hold - Math.min(900, hold / 3));
}

const card = async (title, sub, mono, foot) => {
  await page.evaluate(([a, b, c, d]) => window.__d.card(a, b, c, d), [title, sub, mono, foot]);
  await wait(650);
};
const cardOff = async () => {
  await page.evaluate(() => window.__d.card(null, null, null, null));
  await wait(650);
};
const term = async (title, text) => {
  await page.evaluate(([a, b]) => window.__d.term(a, b), [title, text]);
  await wait(650);
};
const termOff = async () => {
  await page.evaluate(() => window.__d.term(null, null));
  await wait(650);
};

const locate = (sel) => page.locator(sel).first();

async function spotlight(sel, pad = 12) {
  const loc = locate(sel);
  await loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await wait(850);
  await page.evaluate(([b, p]) => window.__d.ring(b, p), [await loc.boundingBox(), pad]);
  await wait(400);
}

/** One ring around a run of adjacent rows. */
async function spotlightRows(sel, from, to) {
  const rows = page.locator(sel);
  await rows.nth(from).evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await wait(850);
  const boxes = [];
  for (let i = from; i <= to; i++) boxes.push(await rows.nth(i).boundingBox());
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  await page.evaluate(
    ([b, p]) => window.__d.ring(b, p),
    [
      {
        x,
        y,
        width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
        height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
      },
      6,
    ],
  );
  await wait(400);
}

const spotOff = async () => {
  await page.evaluate(() => window.__d.ring(null, 0));
  await wait(350);
};

async function click(sel) {
  const loc = locate(sel);
  const b = await loc.boundingBox();
  await page.evaluate(([x, y]) => window.__d.cursor(x, y), [b.x + b.width / 2, b.y + b.height / 2]);
  await wait(650);
  await page.evaluate(() => window.__d.tap());
  await wait(200);
  await loc.click();
  await wait(850);
}

// ---------------------------------------------------------------- the capture

// Navigate on commit and raise the opening cards as soon as the overlay
// exists. The console's load then happens behind them instead of becoming dead
// air at the head of the video.
await page.goto(TARGET, { waitUntil: "commit", timeout: 60000 });
await page.waitForFunction(() => window.__d, null, { timeout: 30000 });

await card(
  "Keyring",
  "Policy-enforced wallet infrastructure for AI agents.",
  null,
  "NEAR testnet · Base Sepolia · Bitcoin testnet4",
);
await beat("open");

await card(
  "The problem",
  "An agent that can pay needs a key.\nA key is authority with no upper bound.",
);
await beat("problem");

await card(
  "Where the boundary goes",
  null,
  "agent runtime  ->  Keyring contract  ->  NEAR Chain Signatures  ->  Base Sepolia\n" +
    "  untrusted          policy is            threshold signing          Bitcoin testnet4\n" +
    "                     enforced here                                   settlement",
  "the agent holds no key, writes no calldata, and never reaches the signer",
);
await beat("how");

await page.waitForSelector('.card:has-text("Signing backend")', { timeout: 60000 });
await cardOff();

// Overview
await beat("overview");

await spotlight('.card:has-text("Signing backend")');
await beat("mpc");
await spotOff();

await spotlight('.card:has-text("Refused before signing")');
await beat("refused");
await spotOff();

await spotlight('.card:has(h2:text-is("Owner-wide budget"))');
await beat("budget");
await spotOff();

// Agents
await click('[data-tab="agents"]');
await beat("agents");

await spotlight(".addresses");
await beat("addresses");
await spotOff();

await spotlight('.pill:has-text("change key registered")', 14);
await beat("btckey");
await spotOff();

await spotlight('.card:has-text("per request max") >> nth=0');
await beat("caps");
await spotOff();

// Activity
await click('[data-tab="activity"]');
await beat("activity");

await spotlight("table.data tbody tr >> nth=0", 6);
await beat("refusal");
await spotOff();

await spotlightRows("table.data tbody tr", 1, 3);
await beat("signed");
await spotOff();

// Independent verification
await term(`node scripts/verify-signature.mjs ${ACCOUNT} ${VERIFY_REQUEST}`, verifyOutput);
await beat("verify");

await page.evaluate(() => window.__d.term(null, null));
await card(
  "Settled on chain",
  null,
  "native ETH     Base Sepolia       block 56,931,717\n" +
    "ERC-20 USDC    Base Sepolia       block 56,963,072\n" +
    "native BTC     Bitcoin testnet4   block 160,377",
  "every one of them signed by the MPC network, broadcast by a relayer",
);
await beat("onchain");
await cardOff();

// Owner actions
await click('[data-tab="owner"]');
await spotlight('.card:has-text("Connect the owner wallet to act")');
await beat("owner");
await spotOff();

// What is not claimed
await card(
  "What is not claimed",
  "Nothing audited. Nothing on mainnet.\nBitcoin is one input, native segwit only — unsupported rather than half-supported.",
  null,
  "Keyring bounds the blast radius. It does not remove it.",
);
await beat("limits");

await card("Keyring", "Policy-enforced wallet infrastructure for AI agents.", null, "github.com/Antismart/keyring");
await beat("close");

await page.evaluate(() => window.__d.cap(null));
await wait(1200);

const total = at();
await context.close();
await browser.close();

// ------------------------------------------------------------- the deliverable
const produced = (await fs.readdir(OUT)).filter((f) => f.endsWith(".webm"));
const video = path.join(OUT, "keyring-demo.webm");
if (produced.length) await fs.rename(path.join(OUT, produced[0]), video);

const stamp = (ms) =>
  `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;

await fs.writeFile(
  path.join(OUT, "cues.json"),
  JSON.stringify({ video: path.basename(video), duration_ms: total, cues }, null, 2) + "\n",
);
await fs.writeFile(
  path.join(OUT, "cues.md"),
  `# Narration cue sheet\n\n` +
    `Generated by \`scripts/record-demo.mjs\` from ${TARGET}\n\n` +
    `Video: \`${path.basename(video)}\` · ${stamp(total)}\n\n` +
    `Each line is spoken from the timestamp given; the caption column is what\n` +
    `appears on screen at the same moment. \`scripts/mix-demo.mjs\` places the\n` +
    `clips at these timestamps, so nothing needs aligning by hand.\n\n` +
    `| In | Hold | Spoken | On screen |\n|---|---|---|---|\n` +
    cues
      .map(
        (c) =>
          `| ${stamp(c.at)} | ${(c.hold / 1000).toFixed(1)}s | ${c.say.replace(/\|/g, "\\|")} | ${c.cap.replace(/\|/g, "\\|")} |`,
      )
      .join("\n") +
    "\n",
);

console.log(`\n${video}\n${stamp(total)} · ${cues.length} cues · ${OUT}/cues.md`);
console.log(problems.length ? `page problems:\n  ${problems.join("\n  ")}` : "no page errors");
