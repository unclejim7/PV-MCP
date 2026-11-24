# PitViper MCP

Lets Claude use **app.pitviper.trading** (simulated prediction-market betting — no real money) by driving a real browser on your machine.

## Setup (one time)

Needs Node 18+.

```bash
cd PV-MCP            # this repo
npm install          # also downloads Chromium for Playwright
npm run login        # opens a browser — sign in, tick "Keep me signed in"
```

The window closes on its own once you're signed in. The session is saved in `~/.pitviper-mcp/profile`.

## Add to Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "pitviper": {
      "command": "node",
      "args": ["/FULL/PATH/TO/pitviper-mcp/src/server.js"]
    }
  }
}
```

Restart Claude Desktop. On Windows use a path like `C:\\Users\\you\\pitviper-mcp\\src\\server.js`.

## Tools

| Tool | What it does |
|---|---|
| `pitviper_status` | Signed in? + Discover page |
| `pitviper_search_markets` | Search markets, returns links |
| `pitviper_open` | Open any PitViper page by path |
| `pitviper_place_bet` | Side + amount → **preview ticket**; `confirm=true` submits. Add `competition` to trade a competition's money |
| `pitviper_competition_book` | Markets in a competition's "Trade the eligible book" list |
| `pitviper_portfolio` | Positions / balance / history |
| `pitviper_click`, `pitviper_fill` | Escape hatches for any UI the high-level tools miss |
| `pitviper_snapshot`, `pitviper_screenshot` | See the current page |

Try: *"Search PitViper for the Bears game and show me the odds"* → *"Put 50 on Yes"* → Claude shows the ticket → *"confirm"*.

## Live prices and submitting

Prices on live games move every play, so a ticket you OK'd can be stale a minute later. Give a floor ("go, anything 1.4x or better"): Claude passes it as `min_multiplier`, and the tool only submits if the ticket still pays at least that, reading it from the ticket's `$stake → $payout` line.

After clicking the ticket's Buy button, the tool waits for the order to go through (the ticket closes or clears, or a success message appears). It says **SUBMITTED** only then. **NOT CONFIRMED** means treat it as not placed, so check the portfolio before retrying.

## Competitions

Orders from a plain market page are funded by **Main**. The Account menu and account dropdown don't switch the paying account (they're just links), so to trade a competition's money pass `competition` (the competition page path) and use the market name from its **Trade the eligible book** list:

*"What's in the eligible book for my competition?"* → *"Put 25 on Yes for Bears at Packers in the competition"* → check the ticket names the competition money → *"confirm"*.

## Options (env vars in the config's `"env"` block)

- `PITVIPER_HEADLESS=false` — watch the browser work
- `PITVIPER_PROFILE` — profile folder (default `~/.pitviper-mcp/profile`)
- `PITVIPER_MAX_CHARS` — snapshot size cap (default 15000)
- `PITVIPER_CHROMIUM` (or `PV_CHROME_PATH`) — use a specific Chrome/Chromium executable. Without it the server uses Playwright's Chromium, or falls back to your installed Google Chrome / Edge (needed on macOS 13, which Playwright no longer ships Chromium for)

## Troubleshooting

- **"NOT SIGNED IN"** — quit Claude Desktop, run `npm run login`, restart Claude.
- **Profile in use / browser won't launch** — `npm run login` and Claude can't share the profile at the same time; close one.
- **A bet step fails** (side or amount box not found) — the tools are built on visible labels, not PitViper's private API. Ask Claude to use `pitviper_snapshot` + `pitviper_click` / `pitviper_fill` to finish it. If PitViper changes its UI, that's where it breaks; tweak the regexes at the top of `placeBet` in `src/browser.js`.
- Navigation is locked to app.pitviper.trading.
