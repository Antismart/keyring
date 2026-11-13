/**
 * Render the owner console headlessly and capture it.
 *
 * Written because there was no other way to see the page, and it immediately
 * earned its place: the first run exposed a layout bug where the console's
 * grid stretched its rows to fill the viewport, leaving large gaps on every
 * tab, and showed that address resolution was slow enough to look broken.
 *
 *   node scripts/screenshot-dashboard.mjs <url> <output-dir>
 *
 * Reports console errors and horizontal overflow; captures light, dark and
 * phone widths plus each tab.
 */

import { chromium } from "playwright";

const URL = process.argv[2];
const OUT = process.argv[3];
const browser = await chromium.launch();
const errors = [];

for (const [name, theme, size] of [
  ["desktop-light", "light", { width: 1440, height: 1000 }],
  ["desktop-dark", "dark", { width: 1440, height: 1000 }],
  ["phone-light", "light", { width: 400, height: 900 }],
]) {
  const ctx = await browser.newContext({ viewport: size, colorScheme: theme });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${name}] ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => errors.push(`[${name}] nav: ${e.message}`));
  await page.waitForTimeout(3500);
  // horizontal overflow check
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) errors.push(`[${name}] HORIZONTAL OVERFLOW`);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await ctx.close();
}

// Also walk the tabs on desktop
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`[tabs] pageerror: ${e.message}`));
await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForTimeout(3000);
for (const tab of ["agents", "activity", "owner"]) {
  await page.click(`[data-tab="${tab}"]`).catch((e) => errors.push(`[tabs] click ${tab}: ${e.message}`));
  await page.waitForTimeout(tab === "agents" ? 5000 : 1200);
  await page.screenshot({ path: `${OUT}/tab-${tab}.png`, fullPage: true });
}
await ctx.close();
await browser.close();

console.log(errors.length ? "ISSUES:\n" + errors.join("\n") : "no console errors, no overflow");
