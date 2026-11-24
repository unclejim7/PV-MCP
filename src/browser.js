// Browser layer: drives app.pitviper.trading with Playwright using a persistent
// profile, so you sign in once (with `npm run login`) and the session sticks.
import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const BASE_URL = (process.env.PITVIPER_URL || "https://app.pitviper.trading").replace(/\/+$/, "");
export const PROFILE_DIR =
  process.env.PITVIPER_PROFILE || path.join(os.homedir(), ".pitviper-mcp", "profile");
const HEADLESS = process.env.PITVIPER_HEADLESS !== "false";
const MAX_CHARS = Number(process.env.PITVIPER_MAX_CHARS || 15000);
const BASE_HOST = new URL(BASE_URL).host;

let context = null;
let page = null;
let lock = Promise.resolve();
let acceptDialogs = false;

/** Run browser work one call at a time (single shared tab). */
export function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/**
 * Launch the browser. Order: an explicit path (PITVIPER_CHROMIUM / PV_CHROME_PATH),
 * then Playwright's bundled Chromium, then the installed Google Chrome or Edge.
 * The fallback matters on systems Playwright no longer ships Chromium for (e.g. macOS 13).
 */
export async function launch({ headless = HEADLESS } = {}) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const base = { headless, viewport: { width: 1280, height: 900 } };
  const explicit = process.env.PITVIPER_CHROMIUM || process.env.PV_CHROME_PATH;
  if (explicit) return chromium.launchPersistentContext(PROFILE_DIR, { ...base, executablePath: explicit });

  const attempts = [{}, { channel: "chrome" }, { channel: "msedge" }];
  const errors = [];
  for (const opt of attempts) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { ...base, ...opt });
    } catch (e) {
      const msg = String(e?.message || e);
      // Only fall through when the browser binary is missing; real launch errors
      // (e.g. profile already in use) should surface as-is.
      if (!/doesn't exist|not found|no such file|is not installed|ENOENT/i.test(msg)) throw e;
      errors.push(`${opt.channel || "bundled chromium"}: ${msg.split("\n")[0]}`);
    }
  }
  throw new Error(
    "No usable browser. Install Google Chrome, or set PITVIPER_CHROMIUM to a Chrome/Chromium executable.\n" +
      errors.join("\n")
  );
}

export async function getPage() {
  if (page && !page.isClosed()) return page;
  if (!context) {
    context = await launch();
    context.on("close", () => {
      context = null;
      page = null;
    });
  }
  page = context.pages()[0] || (await context.newPage());
  page.on("dialog", (d) => (acceptDialogs ? d.accept() : d.dismiss()).catch(() => {}));
  return page;
}

export async function shutdown() {
  if (context) await context.close().catch(() => {});
  context = null;
  page = null;
}

/** Resolve a path or URL and refuse anything off the PitViper host. */
export function resolveUrl(target = "/") {
  const url = new URL(target, BASE_URL + "/");
  if (url.host !== BASE_HOST) throw new Error(`Refusing to navigate off ${BASE_HOST}: ${url.href}`);
  return url.href;
}

async function settle(p, ms = 6000) {
  await p.waitForLoadState("domcontentloaded", { timeout: ms }).catch(() => {});
  await p.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
  await p.waitForTimeout(400);
}

export async function goto(target) {
  const p = await getPage();
  await p.goto(resolveUrl(target), { waitUntil: "domcontentloaded", timeout: 30000 });
  await settle(p);
  return p;
}

export async function isLoginPage(p) {
  const pw = p.getByRole("textbox", { name: /password/i });
  const signIn = p.getByRole("button", { name: /^sign in$/i });
  return (await pw.count()) > 0 && (await signIn.count()) > 0;
}

/** Accessibility-tree snapshot of the page plus in-app links, truncated. */
export async function snapshot(p, { scope } = {}) {
  let root = p.locator("main").first();
  if (scope) root = p.locator(scope).first();
  if ((await root.count()) === 0) root = p.locator("body");
  let tree = "";
  try {
    tree = await root.ariaSnapshot({ timeout: 10000 });
  } catch {
    tree = (await p.locator("body").innerText().catch(() => "")) || "";
  }
  const links = await p
    .$$eval("a[href]", (as) =>
      as.map((a) => ({ text: (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "), href: a.href }))
    )
    .catch(() => []);
  const seen = new Set();
  const appLinks = links
    .filter((l) => {
      try {
        return new URL(l.href).host === BASE_HOST && !seen.has(l.href) && seen.add(l.href);
      } catch {
        return false;
      }
    })
    .slice(0, 80)
    .map((l) => `- ${l.text || "(no text)"} -> ${new URL(l.href).pathname}${new URL(l.href).search}`);

  let out = `URL: ${p.url()}\nTitle: ${await p.title().catch(() => "")}\n`;
  if (await isLoginPage(p)) {
    out += "\n⚠️ NOT SIGNED IN. Run `npm run login` in the pitviper-mcp folder (with Claude closed), sign in, then retry.\n";
  }
  if (tree.length > MAX_CHARS) tree = tree.slice(0, MAX_CHARS) + "\n…(truncated)";
  out += `\n## Page\n${tree}\n`;
  if (appLinks.length) out += `\n## Links\n${appLinks.join("\n")}\n`;
  return out;
}

async function firstVisible(candidates) {
  for (const loc of candidates) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 10); i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return null;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Click by visible text / accessible name, optionally constrained to an ARIA role. */
export async function click(p, { text, role, exact = false }) {
  const name = exact ? text : new RegExp(esc(text), "i");
  const candidates = role
    ? [p.getByRole(role, { name, exact })]
    : [
        p.getByRole("button", { name, exact }),
        p.getByRole("link", { name, exact }),
        p.getByRole("tab", { name, exact }),
        p.getByRole("menuitem", { name, exact }),
        p.getByRole("option", { name, exact }),
        p.getByText(text, { exact }),
      ];
  const el = await firstVisible(candidates);
  if (!el) throw new Error(`Nothing visible to click matching "${text}"${role ? ` (role ${role})` : ""}.`);
  await el.click({ timeout: 10000 });
  await settle(p);
}

/** Fill an input found by label, placeholder, or accessible name. */
export async function fill(p, { field, value, submit = false }) {
  const re = new RegExp(esc(field), "i");
  const el = await firstVisible([
    p.getByLabel(re),
    p.getByPlaceholder(re),
    p.getByRole("textbox", { name: re }),
    p.getByRole("spinbutton", { name: re }),
    p.getByRole("searchbox", { name: re }),
    p.getByRole("combobox", { name: re }),
  ]);
  if (!el) throw new Error(`No visible input matching "${field}".`);
  await el.fill(String(value), { timeout: 10000 });
  if (submit) await el.press("Enter");
  await settle(p);
}

export async function searchMarkets(query) {
  const p = await goto("/discover");
  const findBox = () =>
    firstVisible([
      p.getByRole("searchbox"),
      p.getByPlaceholder(/search/i),
      p.getByRole("textbox", { name: /search|find|filter/i }),
      p.getByLabel(/search/i),
    ]);
  let box = await findBox();
  if (!box) {
    // Discover shows search as a magnifier icon button that reveals the input.
    const icon = await firstVisible([
      p.getByRole("button", { name: /search/i }),
      p.locator('button:has(svg[class*="search" i]), [aria-label*="search" i]'),
    ]);
    if (icon) {
      await icon.click().catch(() => {});
      await settle(p, 3000);
      box = await findBox();
    }
  }
  if (!box) {
    return (
      `Couldn't find a search box on /discover — here's the page so you can navigate manually.\n\n` +
      (await snapshot(p))
    );
  }
  await box.fill(query);
  await box.press("Enter").catch(() => {});
  await settle(p);
  return snapshot(p);
}

const AMOUNT_RE = /amount|stake|wager|bet|risk|spend|shares|contracts|qty|quantity|size|\$/i;
const SUBMIT_RE = /^\s*(place|buy|submit|confirm|trade|bet|review|lock in|take)/i;

/**
 * Open a market, pick a side, enter an amount. With confirm=false it stops at
 * the ticket and returns it for review; with confirm=true it submits.
 */
const ELIGIBLE_RE = /eligible book/i;

/** The competition page's "Trade the eligible book" section (deepest container holding the heading). */
async function eligibleBook(p) {
  const heading = p.getByRole("heading", { name: ELIGIBLE_RE }).or(p.getByText(ELIGIBLE_RE));
  if ((await heading.count()) === 0) return null;
  const containers = p.locator("section, article, div").filter({ has: heading });
  // Document order puts ancestors first; walk from the deepest outward and take the
  // first container that holds more than the heading itself (i.e. the list).
  const n = await containers.count();
  for (let i = n - 1; i >= 0; i--) {
    const c = containers.nth(i);
    if ((await c.locator("a[href], button").count()) > 0) return c;
  }
  return null;
}

/**
 * Start an order from a competition's eligible-book list so it's funded by the
 * competition balance, not Main. Returns true if the side was already clicked
 * (the list row had its own outcome buttons).
 */
async function enterViaCompetition(p, { competition, market, side, sideRe }) {
  await goto(competition);
  if (await isLoginPage(p)) return { login: true };
  const book = await eligibleBook(p);
  if (!book) throw new Error(`No "Trade the eligible book" list on ${competition}. Use pitviper_open on the competition page to check the path.`);

  const marketRe = new RegExp(esc(market), "i");
  // Row inside the book that names the market and has the side button: click it directly.
  const row = book
    .locator("li, article, section, div, a")
    .filter({ hasText: marketRe })
    .filter({ has: p.getByRole("button", { name: sideRe }) })
    .last();
  if ((await row.count()) > 0 && (await row.isVisible().catch(() => false))) {
    await row.getByRole("button", { name: sideRe }).first().click();
    await settle(p);
    return { sidePicked: true };
  }
  // Otherwise open the market from the book (keeps the competition context).
  const entry = await firstVisible([
    book.getByRole("link", { name: marketRe }),
    book.getByRole("button", { name: marketRe }),
    book.getByText(marketRe),
  ]);
  if (!entry) throw new Error(`"${market}" isn't in this competition's eligible book. Use pitviper_competition_book to list what is.`);
  await entry.click();
  await settle(p);
  return { sidePicked: false };
}

export async function competitionBook(competition) {
  const p = await goto(competition);
  if (await isLoginPage(p)) return snapshot(p);
  const book = await eligibleBook(p);
  if (!book) return `No "Trade the eligible book" list found here.\n\n` + (await snapshot(p));
  let tree = await book.ariaSnapshot({ timeout: 10000 }).catch(() => book.innerText());
  if (tree.length > MAX_CHARS) tree = tree.slice(0, MAX_CHARS) + "\n…(truncated)";
  return `URL: ${p.url()}\n\n## Trade the eligible book\n${tree}\n`;
}

export async function placeBet({ market, side, amount, confirm, competition, min_multiplier }) {
  const p = await getPage();
  const sideRe = new RegExp(`^\\s*${esc(side)}\\b`, "i");
  let sidePicked = false;
  if (competition) {
    const r = await enterViaCompetition(p, { competition, market, side, sideRe });
    if (r.login) return snapshot(p);
    sidePicked = r.sidePicked;
  } else {
    await goto(market);
    if (await isLoginPage(p)) return snapshot(p);
  }

  if (!sidePicked) {
    const sideBtn = await firstVisible([
      p.getByRole("button", { name: sideRe }),
      p.getByRole("radio", { name: sideRe }),
      p.getByRole("tab", { name: sideRe }),
      p.getByRole("button", { name: new RegExp(esc(side), "i") }),
    ]);
    if (!sideBtn) throw new Error(`No button for side "${side}" on this market. Use pitviper_snapshot to see the options.`);
    await sideBtn.click();
    await settle(p);
  }

  const amountEl = await firstVisible([
    p.getByRole("spinbutton"),
    p.getByLabel(AMOUNT_RE),
    p.getByPlaceholder(AMOUNT_RE),
    p.getByRole("textbox", { name: AMOUNT_RE }),
    p.locator('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"]'),
  ]);
  if (!amountEl) throw new Error("Picked the side but couldn't find an amount box. Use pitviper_snapshot / pitviper_fill.");
  await amountEl.fill(String(amount));
  await settle(p, 3000);

  if (!confirm) {
    await findSubmit(p, amountEl);
    const pv = await readTicketPrice(p, amountEl, side);
    await clearSubmitMark(p);
    return (
      `PREVIEW ONLY — nothing submitted. Side "${side}", amount ${amount}.\n` +
      (pv.multiplier != null
        ? `Ticket price now: ${fmtX(pv.multiplier)}${pv.detail ? ` (${pv.detail})` : ""}. ` +
          `Live prices move every play; pass min_multiplier on confirm to set a floor.\n`
        : "") +
      (competition
        ? `Funding: started from the eligible book on ${competition} — check the ticket below names the competition money, not Main, before confirming.\n`
        : `Funding: plain market page — this orders from Main. Pass "competition" to trade a competition's money.\n`) +
      `Review the ticket below; call pitviper_place_bet again with the same arguments and confirm=true to submit.\n\n` +
      (await snapshot(p))
    );
  }

  const btn = await findSubmit(p, amountEl);
  const price = await readTicketPrice(p, amountEl, side);
  if (min_multiplier != null) {
    if (price.multiplier == null) {
      await clearSubmitMark(p);
      throw new Error(`Couldn't read the ticket price, so I can't check it against your ${min_multiplier}x floor. Nothing submitted.`);
    }
    if (price.multiplier + 1e-9 < min_multiplier) {
      await clearSubmitMark(p);
      return (
        `NOT SUBMITTED — price ${fmtX(price.multiplier)} is below your ${min_multiplier}x floor` +
        `${price.detail ? ` (${price.detail})` : ""}.\n\n` +
        (await snapshot(p))
      );
    }
  }

  acceptDialogs = true;
  let result;
  try {
    if (!btn) throw new Error("Couldn't find an enabled Buy/Place button on the ticket. Nothing submitted. Use pitviper_snapshot to inspect it.");
    const label = ((await btn.innerText().catch(() => "")) || "").trim().replace(/\s+/g, " ");
    const before = await pageText(p);
    await btn.click({ timeout: 10000 });
    await settle(p, 3000);
    // Two-step tickets ("Review" -> "Confirm"): click a confirm step that just appeared.
    const confirmBtn = await firstVisible([p.getByRole("button", { name: /^\s*(confirm|place order|submit order)/i })]);
    if (confirmBtn && !(await confirmBtn.evaluate((el) => el.hasAttribute("data-pv-submit")).catch(() => false))) {
      if (await confirmBtn.isEnabled().catch(() => false)) {
        await confirmBtn.click();
        await settle(p, 3000);
      }
    }
    result = await verifySubmitted(p, { btn, amountEl, before });
    result.label = label;
  } finally {
    acceptDialogs = false;
    await clearSubmitMark(p);
  }

  const priceLine =
    price.multiplier != null ? `Price at submit: ${fmtX(price.multiplier)}${price.detail ? ` (${price.detail})` : ""}.\n` : "";
  if (result.ok) {
    return (
      `SUBMITTED — clicked "${result.label}"; ${result.why}.\n${priceLine}Confirm the fill with pitviper_portfolio.\n\n` +
      (await snapshot(p))
    );
  }
  return (
    `⚠️ NOT CONFIRMED — clicked "${result.label}" but saw no sign the order went through` +
    `${result.why ? ` (${result.why})` : ""}. Treat it as NOT placed and check pitviper_portfolio before retrying, ` +
    `so you don't double up.\n${priceLine}\n` +
    (await snapshot(p))
  );
}

const fmtX = (m) => `${Math.round(m * 100) / 100}x`;
const pageText = (p) => p.locator("body").innerText().catch(() => "");

/**
 * The ticket's submit button: walk up from the amount box to the smallest
 * container holding an enabled Buy/Place/... button, skipping tabs and toggles
 * (e.g. a Buy|Sell switch). Prefer type=submit, else the last match, since the
 * submit button sits at the bottom of a ticket.
 */
async function findSubmit(p, amountEl) {
  const found = await amountEl.evaluate((input, src) => {
    const re = new RegExp(src, "i");
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const isToggle = (el) =>
      el.getAttribute("role") === "tab" ||
      el.getAttribute("role") === "radio" ||
      el.hasAttribute("aria-selected") ||
      el.hasAttribute("aria-pressed") ||
      !!el.closest('[role="tablist"], [role="radiogroup"]');
    const name = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
    for (let node = input.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const btns = [...node.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(
        (b) => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !isToggle(b) && re.test(name(b))
      );
      if (btns.length) {
        const pick = btns.find((b) => b.type === "submit") || btns[btns.length - 1];
        pick.setAttribute("data-pv-submit", "1");
        return true;
      }
    }
    return false;
  }, SUBMIT_RE.source);
  return found ? p.locator("[data-pv-submit]").first() : null;
}

const ARROW = "(?:→|->|➜|⟶)";
const MONEY = "\\$\\s?([\\d,]+(?:\\.\\d+)?)";

/**
 * Read the ticket's price. The ticket is the smallest container holding both the
 * amount box and the submit button (marked by findSubmit), so other outcomes'
 * prices elsewhere on the page are never picked up. Order: a "$1,500 → $2,219.88"
 * payout line (payout / stake), then an "1.48x" inside the ticket, then the
 * chosen side's own "Bengals 1.48x" button.
 */
async function readTicketPrice(p, amountEl, side) {
  const ticket = await amountEl
    .evaluate((input) => {
      const submit = document.querySelector("[data-pv-submit]");
      for (let n = input.parentElement; n && n !== document.body; n = n.parentElement) {
        if (!submit || n.contains(submit)) return n.innerText || "";
      }
      return "";
    })
    .catch(() => "");
  const num = (s) => Number(s.replace(/,/g, ""));
  const arrow = ticket.match(new RegExp(`${MONEY}\\s*${ARROW}\\s*${MONEY}`));
  if (arrow && num(arrow[1]) > 0) {
    return { multiplier: num(arrow[2]) / num(arrow[1]), detail: `$${arrow[1]} → $${arrow[2]}` };
  }
  const x = ticket.match(/(\d+(?:\.\d+)?)\s?x\b/i);
  if (x) return { multiplier: Number(x[1]), detail: "on ticket" };
  const sideBtn = p.getByRole("button", { name: new RegExp(`^\\s*${esc(side)}\\b.*\\d(\\.\\d+)?\\s?x`, "i") }).first();
  const label = (await sideBtn.innerText({ timeout: 2000 }).catch(() => "")) || "";
  const sx = label.match(/(\d+(?:\.\d+)?)\s?x\b/i);
  if (sx) return { multiplier: Number(sx[1]), detail: `from the "${label.trim().replace(/\s+/g, " ")}" button` };
  return { multiplier: null, detail: "" };
}

const clearSubmitMark = (p) =>
  p
    .evaluate(() => document.querySelectorAll("[data-pv-submit]").forEach((e) => e.removeAttribute("data-pv-submit")))
    .catch(() => {});

const SUCCESS_RE = /order (placed|filled|submitted)|\bfilled\b|bet placed|trade placed|you bought|position opened|success/i;
const FAIL_RE = /insufficient|not enough|price (has )?(changed|moved)|slippage|order failed|couldn.t place|\berror\b/i;

/** Poll for evidence the order went through instead of assuming it did. */
async function verifySubmitted(p, { btn, amountEl, before }) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const now = await pageText(p);
    const fresh = (re) => {
      const m = now.match(re);
      return m && !re.test(before) ? m[0] : null;
    };
    const failed = fresh(FAIL_RE);
    if (failed) return { ok: false, why: `page says "${failed}"` };
    const success = fresh(SUCCESS_RE);
    if (success) return { ok: true, why: `page says "${success}"` };
    if (!(await amountEl.isVisible().catch(() => false))) return { ok: true, why: "the ticket closed" };
    const v = await amountEl.inputValue().catch(() => null);
    if (v === "" || v === "0") return { ok: true, why: "the ticket was cleared" };
    if (!(await btn.isVisible().catch(() => false))) return { ok: true, why: "the submit button went away" };
    await p.waitForTimeout(500);
  }
  return { ok: false, why: "the ticket is still open with the amount filled in" };
}

export async function portfolio() {
  const p = await getPage();
  if (!p.url().startsWith(BASE_URL)) await goto("/discover");
  const nav = await firstVisible([
    p.getByRole("link", { name: /portfolio|positions|my bets|my takes|bets|wallet/i }),
    p.getByRole("tab", { name: /portfolio|positions|bets|takes/i }),
    p.getByRole("button", { name: /portfolio|positions|bets|takes/i }),
  ]);
  if (nav) {
    await nav.click();
    await settle(p);
  } else {
    await goto("/portfolio");
  }
  return snapshot(p);
}

export async function screenshot(fullPage = false) {
  const p = await getPage();
  const buf = await p.screenshot({ fullPage, type: "png" });
  return buf.toString("base64");
}
