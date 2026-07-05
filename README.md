# Price Tracker

Coles & Woolworths price tracker for your recurring shopping list — specials highlighted, price history charted, "buy now or wait for Wednesday" verdicts. **Everything lives in this one GitHub repo:** GitHub Pages hosts the PWA, GitHub Actions runs the scraper, and the data files are committed right here. No servers, no databases, $0.

```
docs/                  ← the PWA, served by GitHub Pages
docs/data/items.json   ← your tracked items (the app commits changes here)
docs/data/prices.json  ← price history (the scraper commits snapshots here)
scraper/scrape.js      ← Playwright scraper, run by Actions
.github/workflows/scrape.yml  ← Mon 5pm + Wed 8am AEST + on-demand
```

## Setup (once, ~10 minutes)

1. **Create the repo:** push this folder to a new **public** GitHub repo (public = free Pages; your item list and prices will be publicly visible).
2. **Enable Pages:** repo → Settings → Pages → Deploy from a branch → `main`, folder `/docs`. Your app appears at `https://<you>.github.io/<repo>/`.
3. **Create a token:** GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new). Scope it to **only this repo**, permissions: **Contents: read & write** and **Actions: read & write**. Set a long expiry.
4. **Open the app on your phone** → ⚙️ Settings → owner/repo are pre-filled → paste the token → Save. Then browser menu → **Add to Home Screen**.
5. **Set up the 🔖 bookmarklet** (dialog in the app has instructions) — this is the bot-proof way to pull prices, and likely your main path for Coles.

## How it works

- **Reading:** the app reads `items.json`/`prices.json` via the GitHub API (instant). Without a token it falls back to reading them from Pages (read-only, ~1 min behind commits).
- **Writing:** adding items, logging catalogue specials, and manual prices are commits made by the app via the GitHub API — your shopping list has version history for free.
- **Scraping:** the workflow runs headless Chromium via Playwright, loads each store's site so the bot-protection JS executes, then fetches your products' prices *from inside the page* (same-origin) and commits `prices.json`. Runs Monday ~5pm and Wednesday ~8am AEST, plus whenever you hit **Refresh** in the app (`workflow_dispatch`).
- **Bot-blocking reality:** Actions runners are datacenter IPs. Woolworths works from CI; **Coles is behind Imperva + hCaptcha and blocks the runner** (it serves an "I am human" page instead of data). No amount of server-side stealth clears that — it's an IP-reputation + CAPTCHA wall, deliberately. The clean fix is to read Coles prices in *your own browser*, where you genuinely are a human on a residential connection: the userscript (below) or the 🔖 bookmarklet. Manual entry (✏️) is the always-works fallback.

## Userscript (hands-off capture in your own browser)

The userscript reads prices while you browse the stores normally — same session, your device, your IP — and commits them to the repo. This is the recommended path for Coles.

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Safari desktop; on Android use **Firefox** + Tampermonkey).
2. Open `userscript/price-tracker.user.js` from this repo (or the raw GitHub URL) — Tampermonkey offers to install it.
3. Click the Tampermonkey icon → **⚙️ Configure Price Tracker** → enter your GitHub owner, repo, and a fine-grained token with **Contents: read & write**.
4. Just visit coles.com.au / woolworths.com.au as normal. A few seconds after a page loads (and isn't a security-check page), it captures your tracked items' prices and pushes them. It self-throttles to once per store per 3 hours; **🔄 Capture prices now** in the menu forces a run.

No bot evasion is involved: the script only runs in a real page you loaded yourself. If Coles ever shows *you* the "I am human" check, tick it like any shopper, then let the script run.

## Weekly routine

- **Monday 5pm** — catalogues drop (app banner links to both). Spot your items → **📖 Log upcoming** → app shows **BUY / WAIT** against today's price.
- **Wednesday** — new specials live. **Refresh** (or bookmarklet on each store site) → check verdicts and **📈 History** charts (diamond points = on special).

## Adding items

Search the product on each store's website, copy the product page URL, paste into the app's add dialog (it extracts the product ID). Coles URLs look like `coles.com.au/product/name-1234567`, Woolworths like `woolworths.com.au/shop/productdetails/123456/name`.

## Notes & caveats

- Actions cron is UTC: `7:05` = Mon 5:05pm **AEST**; during daylight saving (Oct–Apr) runs land an hour later AEDT-time. Scheduled runs can also be delayed a few minutes by GitHub.
- The bookmarklet embeds your token — don't share the bookmark; re-copy it after changing the token.
- Scheduled workflows on free repos are disabled automatically after 60 days without a commit — any app edit (or scrape commit) counts as activity, so weekly use keeps it alive.
- Test the scraper locally: `npm install && npx playwright install chromium && npm run scrape`.
