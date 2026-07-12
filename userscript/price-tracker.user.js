// ==UserScript==
// @name         Price Tracker — Coles & Woolworths auto-capture
// @namespace    https://github.com/phrenetic-labs/price-tracker
// @version      1.0.0
// @description  While you browse Coles/Woolworths in your own session, quietly read prices for your tracked items and commit them to your Price Tracker repo. No bot evasion — runs as you, on your device.
// @match        https://www.coles.com.au/*
// @match        https://www.woolworths.com.au/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.github.com
// ==/UserScript==

/*
 * SETUP (once):
 *   Tampermonkey menu (extension icon → this script) →
 *     "⚙️ Configure Price Tracker" — enter GitHub owner, repo, and a
 *     fine-grained token with Contents: read & write on the repo.
 *
 * USE:
 *   Just browse coles.com.au / woolworths.com.au normally. When you're on
 *   a page that isn't a bot-challenge, the script fetches prices for your
 *   tracked items (same-origin, your real session) and commits prices.json.
 *   It self-throttles to once per store per COOLDOWN window so it won't
 *   hammer anything. Use the menu command to force a run now.
 */

(function () {
  'use strict';

  const COOLDOWN_MIN = 180; // don't auto-run more than once per store per 3h
  const store = location.hostname.includes('coles')
    ? 'coles'
    : location.hostname.includes('woolworths')
    ? 'woolworths'
    : null;
  if (!store) return;

  /* ----------------------------------------------------------- config */
  const cfg = () => ({
    owner: GM_getValue('owner', ''),
    repo: GM_getValue('repo', ''),
    token: GM_getValue('token', ''),
  });
  const configured = () => {
    const c = cfg();
    return c.owner && c.repo && c.token;
  };

  GM_registerMenuCommand('⚙️ Configure Price Tracker', () => {
    const c = cfg();
    const owner = prompt('GitHub owner (username/org):', c.owner);
    if (owner === null) return;
    const repo = prompt('Repo name:', c.repo || 'price-tracker');
    if (repo === null) return;
    const token = prompt(
      'Fine-grained token (Contents: read & write). Leave blank to keep existing:',
      ''
    );
    GM_setValue('owner', owner.trim());
    GM_setValue('repo', repo.trim());
    if (token && token.trim()) GM_setValue('token', token.trim());
    toast('Price Tracker configured ✔');
  });

  GM_registerMenuCommand('🔄 Capture prices now', () => run(true));

  /* ------------------------------------------------------------ ui */
  let bubble;
  function toast(msg, spin) {
    if (!bubble) {
      bubble = document.createElement('div');
      Object.assign(bubble.style, {
        position: 'fixed', zIndex: 2147483647, right: '16px', bottom: '16px',
        background: '#1c1c2b', color: '#e8e8f0', font: '13px -apple-system, sans-serif',
        padding: '10px 14px', borderRadius: '10px', boxShadow: '0 4px 16px rgba(0,0,0,.4)',
        maxWidth: '80vw', border: '1px solid #32324a', transition: 'opacity .3s',
      });
      document.body.appendChild(bubble);
    }
    bubble.textContent = (spin ? '⏳ ' : '') + msg;
    bubble.style.opacity = '1';
    clearTimeout(bubble._h);
    if (!spin) bubble._h = setTimeout(() => (bubble.style.opacity = '0'), 4000);
  }

  /* --------------------------------------------------- github (GM) */
  const b64e = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64d = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ''))));

  function gh(method, path, body) {
    const c = cfg();
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `https://api.github.com/repos/${c.owner}/${c.repo}/${path}`,
        headers: {
          Authorization: 'Bearer ' + c.token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) resolve(JSON.parse(r.responseText));
          else reject(new Error(`GitHub ${method} ${path}: HTTP ${r.status}`));
        },
        onerror: () => reject(new Error('network error talking to GitHub')),
      });
    });
  }

  async function readFile(file) {
    const j = await gh('GET', `contents/docs/data/${file}?_=${Date.now()}`);
    return { data: JSON.parse(b64d(j.content)), sha: j.sha };
  }
  async function writeFile(file, obj, sha, message) {
    return gh('PUT', `contents/docs/data/${file}`, {
      message,
      content: b64e(JSON.stringify(obj, null, 2) + '\n'),
      sha,
    });
  }

  /* ------------------------------------------------- in-page price read */
  function todayISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
  }

  function looksBlocked() {
    const t = (document.title || '') + ' ' + (document.body ? document.body.innerText.slice(0, 400) : '');
    return /additional security check|hcaptcha|imperva|are you a robot|access denied|pardon our interruption/i.test(t);
  }

  // Recursively find the product node that carries a usable price.
  function findColesPricing(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    const p = obj.pricing || obj.price;
    if (p && typeof p === 'object') {
      const now = p.now ?? p.value ?? p.current ?? (typeof p === 'number' ? p : null);
      if (now != null && !isNaN(Number(now))) {
        const was = p.was ?? p.wasPrice ?? null;
        return { now: Number(now), was: was != null ? Number(was) : null,
                 promo: p.specialType || p.promotionType || p.onPromotion };
      }
    }
    for (const k of Object.keys(obj)) {
      const hit = findColesPricing(obj[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  // Pull a price out of any JSON-LD Product/Offer blocks in the HTML.
  function priceFromJsonLd(html) {
    const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      try {
        const j = JSON.parse(m[1]);
        const nodes = Array.isArray(j) ? j : [j];
        for (const n of nodes) {
          const offer = n && n.offers && (Array.isArray(n.offers) ? n.offers[0] : n.offers);
          if (offer && offer.price != null) {
            return { now: Number(offer.price), was: null, promo: false };
          }
        }
      } catch (e) { /* next block */ }
    }
    return null;
  }

  async function priceColes(id) {
    // Fetch the real product page HTML (same as a browser navigation).
    const r = await fetch(`/product/p-${id}`, { headers: { accept: 'text/html' } });
    if (!r.ok) throw new Error('page HTTP ' + r.status);
    const html = await r.text();
    if (/additional security check|hcaptcha|imperva/i.test(html)) {
      throw new Error('security-check page — solve the “I am human” box, then retry');
    }
    // 1) legacy __NEXT_DATA__ (Pages Router)
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const product = data.props && data.props.pageProps && data.props.pageProps.product;
        const hit = findColesPricing(product || data.props, 0);
        if (hit) return snap(hit.now, hit.was, hit.promo);
      } catch (e) { /* fall through */ }
    }
    // 2) JSON-LD (App Router server-renders this)
    const ld = priceFromJsonLd(html);
    if (ld) return snap(ld.now, ld.was, ld.promo);
    throw new Error('no price found in page');
  }

  async function priceWoolworths(id) {
    const r = await fetch(`/apis/ui/product/detail/${id}?isMobile=false`, {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) throw new Error('API HTTP ' + r.status);
    const j = await r.json();
    const p = j.Product || j;
    if (!p || p.Price == null) throw new Error('no price');
    return {
      price: p.Price,
      wasPrice: p.WasPrice > p.Price ? p.WasPrice : null,
      onSpecial: !!p.IsOnSpecial,
    };
  }

  function snap(now, was, promo) {
    return {
      price: now,
      wasPrice: was > now ? was : null,
      onSpecial: !!(was > now || promo),
    };
  }

  const PRICER = { coles: priceColes, woolworths: priceWoolworths };

  /* ------------------------------------------------------------ run */
  let running = false;
  async function run(manual) {
    if (running) return;
    if (!configured()) {
      if (manual) toast('Not configured — use the ⚙️ menu command first');
      return;
    }
    if (looksBlocked()) {
      if (manual) toast('This looks like a security-check page — solve it, then retry');
      return;
    }
    const key = `lastRun_${store}`;
    const last = GM_getValue(key, 0);
    if (!manual && Date.now() - last < COOLDOWN_MIN * 60000) return; // throttle

    running = true;
    try {
      toast(`Reading ${store} prices…`, true);
      const items = await readFile('items.json');
      const list = items.data.filter(
        (i) => i.stores && i.stores[store] && i.stores[store].productId
      );
      if (!list.length) {
        toast(`No ${store} items tracked`);
        return;
      }
      const prices = await readFile('prices.json');
      prices.data.history = prices.data.history || {};
      const date = todayISO();
      let n = 0;
      const fails = [];
      for (const it of list) {
        try {
          const s = await PRICER[store](it.stores[store].productId);
          const rows = (prices.data.history[it.id] || []).filter(
            (h) => !(h.date === date && h.store === store)
          );
          rows.push({ date, store, price: s.price, wasPrice: s.wasPrice, onSpecial: s.onSpecial, manual: false });
          rows.sort((a, b) => (a.date < b.date ? -1 : 1));
          prices.data.history[it.id] = rows;
          n++;
          await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
        } catch (e) {
          fails.push(`${it.name}: ${e.message}`);
          console.warn('[Price Tracker]', it.name, '→', e.message);
        }
      }
      if (n) {
        prices.data.lastRefresh = new Date().toISOString();
        await writeFile('prices.json', prices.data, prices.sha, `Userscript prices (${store})`);
      }
      GM_setValue(key, Date.now());
      if (n) {
        toast(`${store}: pushed ${n}/${list.length} ✔${fails.length ? ` · ${fails.length} missed` : ''}`);
      } else {
        // nothing captured — show the first reason so it's debuggable
        toast(`${store}: 0/${list.length} — ${fails[0] || 'no items'}`);
      }
    } catch (e) {
      toast('Error: ' + e.message);
    } finally {
      running = false;
    }
  }

  // Give the page a few seconds to settle (SPA hydration, protection JS), then auto-run.
  setTimeout(() => run(false), 6000);
})();
