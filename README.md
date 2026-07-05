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
- **Bot-blocking reality:** Actions runners are datacenter IPs. Woolworths will probably work; Coles (Akamai) may block even Playwright. When that happens: open coles.com.au on your phone, tap the 🔖 bookmarklet — it fetches prices from inside the real page in your real browser (indistinguishable from you) and commits them via the GitHub API. Manual entry (✏️) is the always-works fallback.

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
