// Shared operations used by the CLI and the local web server.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runListings, saveDetail, upsertListing } from './db.js';
import { parseDetailPage, parseSearchPage } from './extract.js';
import { BlockedError } from './fetcher.js';
import { rank, COMPONENTS } from './score.js';
import { listingUrl } from './url.js';

export function latestRun(db) {
  return db.prepare('SELECT * FROM runs ORDER BY updated_at DESC, id DESC LIMIT 1').get() ?? null;
}

export function rankRun(db, { runId, priorities, filters, top = 50 } = {}) {
  const rid = runId ?? latestRun(db)?.id;
  return rank(runListings(db, rid), { priorities, filters, top });
}

/**
 * Fetch detail pages (description + attribute table) for a shortlist only: the best `n` ranked groups
 * (all offers in them) that have not been enriched yet.
 */
export async function enrichShortlist(db, fetcher, { n = 40, runId, priorities, filters, log = console.log } = {}) {
  const r = rankRun(db, { runId, priorities, filters, top: n });
  const todo = r.results.flatMap(g => g.offers).map(o => o.listing).filter(l => !l.detail_fetched_at);
  log(`Shortlist: ${r.results.length} groups, ${todo.length} listings need detail pages.`);
  let done = 0;
  for (const l of todo) {
    try {
      const { body } = await fetcher.get(listingUrl(l.id));
      saveDetail(db, l.id, parseDetailPage(body));
      done++;
      log(`  enriched ${l.id} (${done}/${todo.length})`);
    } catch (e) {
      log(`STOPPED enrichment at ${l.id}: ${e.message}`);
      if (e instanceof BlockedError) return { done, total: todo.length, stopped: e.message };
    }
  }
  return { done, total: todo.length, stopped: null };
}

/** Flat, UI/JSON-friendly view of ranking output. */
export function serialize(r) {
  const offer = o => ({
    id: o.listing.id, url: o.listing.url, title: o.listing.title, price_km: o.listing.price_km, price_raw: o.listing.price_raw,
    total: o.total, confidence: o.confidence, flags: o.flags, enriched: !!o.listing.detail_fetched_at,
    specs: Object.fromEntries(['model', 'cpu', 'ram_gb', 'storage', 'screen_in', 'resolution', 'panel', 'refresh_hz', 'condition', 'warranty', 'gpu', 'battery']
      .map(k => [k, o.specs[k] ? { value: o.specs[k].value, source: o.specs[k].source, evidence: o.specs[k].evidence } : null])),
    components: Object.fromEntries(Object.entries(o.components).map(([k, c]) => [k, { label: COMPONENTS[k], score: c.score, evidence: c.evidence }])),
  });
  return {
    weights: r.weights, considered: r.considered, passedFilters: r.passedFilters, groups: r.groups,
    results: r.results.map(g => ({ rank: g.rank, groupKey: g.key, offerCount: g.offers.length, best: offer(g.best), offers: g.offers.map(offer) })),
  };
}

export function exportResults(db, { out = 'data/results', ...opts } = {}) {
  const run = opts.runId ? db.prepare('SELECT * FROM runs WHERE id=?').get(opts.runId) : latestRun(db);
  const data = { generated_at: new Date().toISOString(), run, options: opts, ...serialize(rankRun(db, opts)) };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.json`, JSON.stringify(data, null, 2));
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const s = (o, k) => { const v = o.specs[k]?.value; return v == null ? '' : typeof v === 'object' ? (v.name ?? v.model ?? v.gb ?? v.months ?? JSON.stringify(v)) : v; };
  const rows = [['rank', 'offers_in_group', 'total', 'confidence_pct', 'price_km', 'title', 'model', 'cpu', 'ram_gb', 'storage_gb', 'screen_in', 'resolution', 'condition',
    ...Object.keys(COMPONENTS).map(k => `${k}_score`), 'flags', 'url']];
  for (const g of data.results) {
    const b = g.best;
    rows.push([g.rank, g.offerCount, b.total, b.confidence, b.price_km, b.title, s(b, 'model'), s(b, 'cpu'), s(b, 'ram_gb'), s(b, 'storage'), s(b, 'screen_in'),
      s(b, 'resolution'), s(b, 'condition'), ...Object.keys(COMPONENTS).map(k => b.components[k].score ?? 'unknown'), b.flags.join('; '), b.url]);
  }
  writeFileSync(`${out}.csv`, rows.map(r => r.map(esc).join(',')).join('\n') + '\n');
  return { json: `${out}.json`, csv: `${out}.csv`, count: data.results.length };
}

/** Load the bundled synthetic fixtures into a DB so the UI can be tried without network access. */
export function loadDemo(db, fixturesDir) {
  const url = 'https://olx.ba/pretraga?category_id=39&attr=ram(16)&demo=fixtures';
  db.prepare(`INSERT INTO runs (search_url, status, status_detail, next_page, pages_fetched) VALUES (?, 'complete', 'DEMO: loaded from synthetic fixtures, not live data', 4, 3)
    ON CONFLICT(search_url) DO NOTHING`).run(url);
  const run = db.prepare('SELECT id FROM runs WHERE search_url=?').get(url);
  const files = ['search-page-1.html', 'search-page-2.html', 'api-search.json'];
  files.forEach((f, i) => {
    for (const l of parseSearchPage(readFileSync(`${fixturesDir}/${f}`, 'utf8')).listings) {
      upsertListing(db, l);
      db.prepare('INSERT OR IGNORE INTO run_listings (run_id, listing_id, page) VALUES (?,?,?)').run(run.id, l.id, i + 1);
    }
  });
  saveDetail(db, '61000001', parseDetailPage(readFileSync(`${fixturesDir}/detail-61000001.html`, 'utf8')));
  return run.id;
}
