#!/usr/bin/env node
/**
 * Playwright scraper — runs in GitHub Actions (or locally).
 *
 * Strategy (v2, hardened against bot protection):
 *  - headful real Chrome when available (run under xvfb in CI) — headless
 *    Chromium is trivially fingerprinted by Akamai
 *  - hide automation markers before any page script runs
 *  - navigate to each *product page* like a shopper would, let the
 *    protection JS settle, then read the price from the page's embedded
 *    data (falling back to same-origin API calls)
 *
 * Writes docs/data/prices.json for GitHub Pages to serve.
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

const PRODUCT_URL = {
  coles: (id) => `https://www.coles.com.au/product/p-${id}`,
  woolworths: (id) => `https://www.woolworths.com.au/shop/productdetails/${id}`,
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

/* ---- In-page extractors (run in the browser on the product page) ---- */

const EXTRACT_COLES = async (id) => {
  // 1) product data embedded in the page we're standing on
  try {
    const nd = window.__NEXT_DATA__;
    const p = nd && nd.props && nd.props.pageProps && nd.props.pageProps.product;
    const q = p && p.pricing;
    if (q && q.now != null) {
      return {
        price: q.now,
        wasPrice: q.was > q.now ? q.was : null,
        onSpecial: !!(q.was > q.now || q.specialType || q.promotionType),
      };
    }
  } catch (e) { /* fall through */ }
  // 2) same-origin API (now that we're a "settled" visitor with cookies)
  const b = (window.__NEXT_DATA__ || {}).buildId;
  if (!b) return { error: 'no buildId (bot challenge page?)' };
  const r = await fetch(`/_next/data/${b}/en/product/p-${id}.json?slug=p-${id}`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) return { error: 'API HTTP ' + r.status };
  const j = await r.json();
  const q2 = ((j.pageProps || {}).product || {}).pricing;
  if (!q2 || q2.now == null) return { error: 'no price in response' };
  return {
    price: q2.now,
    wasPrice: q2.was > q2.now ? q2.was : null,
    onSpecial: !!(q2.was > q2.now || q2.specialType || q2.promotionType),
  };
};

const EXTRACT_WOOLWORTHS = async (id) => {
  // 1) same-origin API with full page cookies
  try {
    const r = await fetch(`/apis/ui/product/detail/${id}?isMobile=false`, {
      headers: { accept: 'application/json' },
    });
    if (r.ok) {
      const j = await r.json();
      const p = j.Product || j;
      if (p && p.Price != null) {
        return {
          price: p.Price,
          wasPrice: p.WasPrice > p.Price ? p.WasPrice : null,
          onSpecial: !!p.IsOnSpecial,
        };
      }
    }
  } catch (e) { /* fall through */ }
  // 2) JSON-LD embedded in the product page (price only, no was-price)
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent);
      const nodes = Array.isArray(j) ? j : [j];
      for (const n of nodes) {
        const offer = n && n.offers && (Array.isArray(n.offers) ? n.offers[0] : n.offers);
        if (offer && offer.price != null) {
          return { price: Number(offer.price), wasPrice: null, onSpecial: false, approx: true };
        }
      }
    } catch (e) { /* next script */ }
  }
  return { error: 'no price found on page' };
};

const EXTRACT = { coles: EXTRACT_COLES, woolworths: EXTRACT_WOOLWORTHS };

/* ------------------------------------------------------------ browser */

async function launchBrowser() {
  const opts = {
    headless: false, // run under xvfb in CI — headful is far less fingerprintable
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  };
  try {
    return await chromium.launch({ ...opts, channel: 'chrome' }); // real Chrome
  } catch {
    console.log('(real Chrome unavailable — falling back to Chromium)');
    return await chromium.launch(opts);
  }
}

async function newStealthContext(browser) {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-AU', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  return ctx;
}

async function looksBlocked(page) {
  return page.evaluate(() => {
    const t = (document.title || '') + ' ' + document.body.innerText.slice(0, 400);
    return /access denied|pardon our interruption|are you a robot|request unsuccessful|incapsula|reference #/i.test(t);
  }).catch(() => false);
}

async function scrapeStore(browser, store, entries, prices, date, errors) {
  console.log(`\n=== ${store}: ${entries.length} product(s) ===`);
  const ctx = await newStealthContext(browser);
  const page = await ctx.newPage();
  try {
    // Arrive at the homepage like a shopper; let protection JS settle.
    await page.goto(HOME[store], { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    if (await looksBlocked(page)) {
      throw new Error('bot challenge on homepage — runner IP is blocked');
    }

    let ok = 0;
    for (const { itemId, name, productId, url } of entries) {
      try {
        const target = url || PRODUCT_URL[store](productId);
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4000);
        const snap = await page.evaluate(EXTRACT[store], productId);
        if (snap.error) throw new Error(snap.error);
        appendSnap(prices, itemId, store, snap, date);
        ok++;
        console.log(`  ✔ ${name}: $${snap.price}${snap.onSpecial ? ' (SPECIAL)' : ''}${snap.approx ? ' (basic price only)' : ''}`);
      } catch (e) {
        errors.push(`${name} @ ${store}: ${e.message.split('\n')[0]}`);
        console.log(`  ✘ ${name}: ${e.message.split('\n')[0]}`);
      }
      await page.waitForTimeout(1500); // be polite
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
        byStore[store].push({
          itemId: item.id,
          name: item.name,
          productId: link.productId,
          url: link.url,
        });
      }
    }
  }

  const total = byStore.coles.length + byStore.woolworths.length;
  if (!total) {
    console.log('No tracked products — nothing to scrape.');
    return;
  }

  const browser = await launchBrowser();
  const errors = [];
  const date = todayISO();

  for (const store of ['woolworths', 'coles']) {
    if (!byStore[store].length) continue;
    try {
      await scrapeStore(browser, store, byStore[store], prices, date, errors);
    } catch (e) {
      errors.push(`${store}: ${e.message.split('\n')[0]}`);
      console.log(`  ✘ ${store} entirely failed: ${e.message.split('\n')[0]}`);
    }
  }
  await browser.close();

  const snapped = total - errors.length;
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
