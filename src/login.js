#!/usr/bin/env node
// One-time sign-in: opens a visible browser on PitViper using the MCP's saved
// profile. Sign in yourself (tick "Keep me signed in"); the window closes once
// you're in. Close Claude Desktop first — the profile can't be open twice.
import { launch, BASE_URL, PROFILE_DIR, isLoginPage } from "./browser.js";

const ctx = await launch({ headless: false });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
console.log(`Profile: ${PROFILE_DIR}`);
console.log("Sign in to PitViper in the browser window (tick 'Keep me signed in'). Waiting up to 10 minutes…");

const deadline = Date.now() + 10 * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  if (page.isClosed()) break;
  if (!(await isLoginPage(page).catch(() => true))) {
    ok = true;
    break;
  }
}
if (ok) {
  await page.waitForTimeout(3000); // let cookies/storage flush
  console.log("✅ Signed in. Session saved — you can start Claude Desktop now.");
} else {
  console.log("❌ Didn't detect a sign-in. Run `npm run login` again.");
}
await ctx.close();
process.exit(ok ? 0 : 1);
