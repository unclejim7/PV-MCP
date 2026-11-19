#!/usr/bin/env node
// PitViper MCP server (stdio). Drives app.pitviper.trading — a simulated
// prediction-market app (no real money) — through a headless browser.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as b from "./browser.js";

const server = new McpServer({ name: "pitviper", version: "0.1.0" });

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true });

/** Register a tool whose handler runs under the browser lock with error capture. */
function tool(name, description, shape, handler) {
  server.tool(name, description, shape, async (args) => {
    try {
      return await b.withLock(() => handler(args));
    } catch (e) {
      return fail(e);
    }
  });
}

tool(
  "pitviper_status",
  "Check whether the PitViper session is signed in, and show the current page. Run this first.",
  {},
  async () => {
    const p = await b.goto("/discover");
    const signedIn = !(await b.isLoginPage(p));
    return text(
      (signedIn ? "✅ Signed in.\n\n" : "❌ Not signed in. The user must run `npm run login` in the pitviper-mcp folder.\n\n") +
        (await b.snapshot(p))
    );
  }
);

tool(
  "pitviper_open",
  "Open a PitViper page by path (e.g. /discover, /portfolio, or a market path from a link list) and return its contents and links.",
  { path: z.string().describe("Path or full URL on app.pitviper.trading, e.g. /discover") },
  async ({ path }) => text(await b.snapshot(await b.goto(path)))
);

tool(
  "pitviper_snapshot",
  "Return the current page's accessibility tree and in-app links (no navigation). Use after clicks to see what changed.",
  { scope: z.string().optional().describe("Optional CSS selector to limit the snapshot, e.g. 'dialog'") },
  async ({ scope }) => text(await b.snapshot(await b.getPage(), { scope }))
);

tool(
  "pitviper_search_markets",
  "Search PitViper's markets (prediction markets, sports, crypto) from the Discover page. Returns results with links to each market.",
  { query: z.string().describe("Search text, e.g. 'Bears', 'Fed rate', 'Bitcoin'") },
  async ({ query }) => text(await b.searchMarkets(query))
);

tool(
  "pitviper_place_bet",
  "Place a simulated bet. Opens the market, selects the side, enters the amount. " +
    "With confirm=false (default) it STOPS at the order ticket and returns it for review — show it to the user. " +
    "Only call with confirm=true after the user approves that exact ticket.",
  {
    market: z.string().describe("Market path or URL (from a link in search/open results)"),
    side: z.string().describe("Outcome button label as shown, e.g. 'Yes', 'No', or a team name"),
    amount: z.number().positive().describe("Simulated amount to enter in the ticket"),
    confirm: z.boolean().default(false).describe("false = preview only; true = submit"),
  },
  async (args) => text(await b.placeBet(args))
);

tool(
  "pitviper_portfolio",
  "Show open positions, balance, and bet history (navigates to the portfolio/positions area).",
  {},
  async () => text(await b.portfolio())
);

tool(
  "pitviper_click",
  "Click a button, link, tab, or text on the current page by its visible label. Escape hatch when a high-level tool doesn't fit the UI.",
  {
    text: z.string().describe("Visible label or accessible name to click"),
    role: z.enum(["button", "link", "tab", "menuitem", "option", "radio", "checkbox"]).optional(),
    exact: z.boolean().default(false),
  },
  async (args) => {
    const p = await b.getPage();
    await b.click(p, args);
    return text(await b.snapshot(p));
  }
);

tool(
  "pitviper_fill",
  "Type into an input on the current page, found by its label, placeholder, or name (e.g. 'Amount', 'Search').",
  {
    field: z.string().describe("Label/placeholder text of the input"),
    value: z.string(),
    submit: z.boolean().default(false).describe("Press Enter after typing"),
  },
  async (args) => {
    const p = await b.getPage();
    await b.fill(p, args);
    return text(await b.snapshot(p));
  }
);

tool(
  "pitviper_screenshot",
  "Take a screenshot of the current page.",
  { full_page: z.boolean().default(false) },
  async ({ full_page }) => ({
    content: [{ type: "image", data: await b.screenshot(full_page), mimeType: "image/png" }],
  })
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await b.shutdown();
    process.exit(0);
  });
}
process.stdin.on("close", async () => {
  await b.shutdown();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
console.error("pitviper-mcp running on stdio");
