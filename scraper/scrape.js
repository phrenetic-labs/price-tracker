#!/usr/bin/env node
/**
 * Playwright scraper — runs in GitHub Actions (or locally).
 * Opens each store's site in headless Chromium (so bot-protection JS runs),
 * then fetches product prices from *inside* the page (same-origin),
 * and writes docs/data/prices.json for GitHub Pages to serve.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ITEMS_FILE = path.join(ROOT, 'docs', 'data', 'items.json');
const PRICES_FILE = path.join(ROOT, 'docs', 'data', 'prices.json');

const HOME = {
  coles: 'https://www.coles.com.au/',
  woolworths: 'https://www.woolworths.com.au/',
};

function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}

function appendSnap(prices, itemId, store, snap, date) {
  const rows = (prices.history[itemId] || []).filter(
    (h) => !(h.date === date && h.store === store)
  );
  rows.push({
    date,
    store,
    price: snap.price,
    wasPrice: snap.wasPrice ?? null,
    onSpecial: !!snap.onSpecial,
    manual: false,
  });
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  prices.history[itemId] = rows;
}

/* In-page fetchers — these run inside the browser on the store's origin. */

const FETCH_WOOLWORTHS = async (id) => {
  const r = await fetch(`/apis/ui/product/detail/${id}?isMobile=false`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) return { error: 'HTTP ' + r.status };
  const j = await r.json();
  const p = j.Product || j;
  if (!p || p.Price == null) return { error: 'no price in response' };
  return {
    price: p.Price,
    wasPrice: p.WasPrice > p.Price ? p.WasPrice : null,
    onSpecial: !!p.IsOnSpecial,
  };
};

const FETCH_COLES = async (id) => {
  const b = (window.__NEXT_DATA__ || {}).buildId;
  if (!b) return { error: 'no buildId (bot challenge page?)' };
  const r = await fetch(`/_next/data/${b}/en/product/p-${id}.json?slug=p-${id}`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) return { error: 'HTTP ' + r.status };
  const j = await r.json();
  const q = ((j.pageProps || {}).product || {}).pricing;
  if (!q || q.now == null) return { error: 'no price in response' };
  return {
    price: q.now,
    wasPrice: q.was > q.now ? q.was : null,
    onSpecial: !!(q.was > q.now || q.specialType || q.promotionType),
  };
};

const IN_PAGE = { coles: FETCH_COLES, woolworths: FETCH_WOOLWORTHS };

async function scrapeStore(browser, store, entries, prices, date, errors) {
  console.log(`\n=== ${store}: ${entries.length} product(s) ===`);
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(HOME[store], { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000); // let bot-protection scripts settle

    let ok = 0;
    for (const { itemId, name, productId } of entries) {
      try {
        const snap = await page.evaluate(IN_PAGE[store], productId);
        if (snap.error) throw new Error(snap.error);
        appendSnap(prices, itemId, store, snap, date);
        ok++;
        console.log(`  ✔ ${name}: $${snap.price}${snap.onSpecial ? ' (SPECIAL)' : ''}`);
      } catch (e) {
        errors.push(`${name} @ ${store}: ${e.message}`);
        console.log(`  ✘ ${name}: ${e.message}`);
      }
      await page.waitForTimeout(700); // be polite
    }
    console.log(`${store}: ${ok}/${entries.length} ok`);
  } finally {
    await ctx.close();
  }
}

(async () => {
  const items = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));
  let prices;
  try {
    prices = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
  } catch {
    prices = { lastRefresh: null, history: {} };
  }
  prices.history = prices.history || {};

  const byStore = { coles: [], woolworths: [] };
  for (const item of items) {
    for (const store of Object.keys(byStore)) {
      const link = (item.stores || {})[store];
      if (link && link.productId) {
        byStore[store].push({ itemId: item.id, name: item.name, productId: link.productId });
      }
    }
  }

  const total = byStore.coles.length + byStore.woolworths.length;
  if (!total) {
    console.log('No tracked products — nothing to scrape.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const date = todayISO();
  let snapped = 0;
  const before = JSON.stringify(prices.history);

  for (const store of ['woolworths', 'coles']) {
    if (!byStore[store].length) continue;
    try {
      await scrapeStore(browser, store, byStore[store], prices, date, errors);
    } catch (e) {
      errors.push(`${store}: ${e.message}`);
      console.log(`  ✘ ${store} entirely failed: ${e.message}`);
    }
  }
  await browser.close();

  snapped = total - errors.length;
  if (snapped > 0) {
    prices.lastRefresh = new Date().toISOString();
    fs.writeFileSync(PRICES_FILE, JSON.stringify(prices, null, 2) + '\n');
    console.log(`\nWrote ${snapped}/${total} snapshot(s) to prices.json`);
  }
  if (errors.length) {
    console.log(`\n${errors.length} failure(s):\n  - ` + errors.join('\n  - '));
    console.log('Tip: run the 🔖 bookmarklet from your phone/desktop for the failed store.');
  }
  // Fail the workflow only if we got nothing at all (likely fully bot-blocked)
  if (snapped === 0) process.exit(1);
})();
