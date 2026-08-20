#!/usr/bin/env node
/**
 * merge-prices.js BASE OURS OUT
 *
 * Data-level merge of two prices.json files so concurrent writers (the
 * scheduled scrape + the browser bookmarklet/userscript) never produce a
 * git text conflict. Starts from BASE (the latest remote file) and overlays
 * OURS (this run's freshly-scraped data):
 *   - union of items (item ids present in either)
 *   - union of history rows, de-duplicated by (date, store); OURS wins a tie
 *   - lastRefresh = the more recent of the two
 */

const fs = require('fs');

function load(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.history = j.history || {};
    return j;
  } catch {
    return { lastRefresh: null, history: {} };
  }
}

const [, , basePath, oursPath, outPath] = process.argv;
if (!basePath || !oursPath || !outPath) {
  console.error('usage: merge-prices.js BASE OURS OUT');
  process.exit(2);
}

const base = load(basePath);
const ours = load(oursPath);
const out = { lastRefresh: null, history: {} };

const itemIds = new Set([...Object.keys(base.history), ...Object.keys(ours.history)]);
for (const id of itemIds) {
  const map = new Map(); // key: date|store  -> row
  for (const row of base.history[id] || []) map.set(`${row.date}|${row.store}`, row);
  for (const row of ours.history[id] || []) map.set(`${row.date}|${row.store}`, row); // ours wins ties
  const rows = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  out.history[id] = rows;
}

const t = (v) => (v ? Date.parse(v) || 0 : 0);
out.lastRefresh = t(ours.lastRefresh) >= t(base.lastRefresh) ? ours.lastRefresh : base.lastRefresh;

fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
const rowCount = Object.values(out.history).reduce((n, r) => n + r.length, 0);
console.log(`merged: ${itemIds.size} item(s), ${rowCount} row(s)`);
