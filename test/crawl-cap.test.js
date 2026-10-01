// Simulated OLX /api/search that serves at most CAP pages per query, then repeats the last page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { Fetcher } from '../src/fetcher.js';
import { crawl } from '../src/crawl.js';

const SEARCH = 'https://olx.ba/pretraga?category_id=39&attr=abc&per_page=10';
const PER_PAGE = 10, CAP = 5;

function cappedSite({ n = 450, priceParams = ['price_from', 'price_to'], honour = true, prices } = {}) {
  const all = Array.from({ length: n }, (_, i) => ({ id: 70000000 + i, title: `Laptop ${i} i5-8350U 16GB`, price: prices ? prices(i) : 100 + ((i * 37) % 3000) }))
    .sort((a, b) => b.id - a.id);
  const calls = [];
  const transport = async url => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return { status: 404, body: '' };
    assert.equal(u.pathname, '/api/search');
    assert.equal(u.searchParams.get('category_id'), '39', 'filters preserved');
    assert.equal(u.searchParams.get('attr'), 'abc', 'filters preserved');
    let rows = all;
    const lo = u.searchParams.get(priceParams[0]), hi = u.searchParams.get(priceParams[1]);
    if (honour && lo != null) rows = rows.filter(r => r.price >= +lo);
    if (honour && hi != null) rows = rows.filter(r => r.price <= +hi);
    const lastPage = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    const page = Math.min(+(u.searchParams.get('page') || 1), CAP); // the cap: deeper pages repeat page CAP
    const data = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(r => ({ id: r.id, title: r.title, price: r.price, display_price: `${r.price} KM` }));
    return { status: 200, body: JSON.stringify({ data, meta: { total: rows.length, last_page: lastPage, current_page: page } }) };
  };
  const fetcher = new Fetcher({ cacheDir: mkdtempSync(join(tmpdir(), 'olxcap-')), transport, delayMs: 0, jitterMs: 0, sleep: async () => {}, log: null });
  return { calls, fetcher, all };
}
const quiet = { mode: 'api', log: () => {} };

test('pagination cap is detected and price ranges collect every listing', async () => {
  const db = openDb(':memory:');
  const { fetcher, calls } = cappedSite();
  const s = await crawl(db, fetcher, SEARCH, quiet);
  assert.equal(s.cap_page, CAP);
  assert.equal(s.status, 'complete');
  assert.match(s.status_detail, /price ranges crawled/);
  assert.equal(s.unique_listings, 450);
  assert.equal(s.site_total, 450);
  assert.equal(s.price_params, 'price_from,price_to');
  const pages = calls.filter(c => c.includes('/api/search')).length;
  assert.ok(pages < 120, `reasonable number of requests (${pages})`);
});

test('falls back to the second candidate price parameter names', async () => {
  const db = openDb(':memory:');
  const { fetcher } = cappedSite({ priceParams: ['price_min', 'price_max'] });
  const s = await crawl(db, fetcher, SEARCH, quiet);
  assert.equal(s.status, 'complete');
  assert.equal(s.unique_listings, 450);
  assert.equal(s.price_params, 'price_min,price_max');
});

test('if the site ignores price parameters the run is honestly marked capped, not complete', async () => {
  const db = openDb(':memory:');
  const { fetcher } = cappedSite({ honour: false });
  const s = await crawl(db, fetcher, SEARCH, quiet);
  assert.equal(s.status, 'capped');
  assert.match(s.status_detail, /ignored the price-range parameters/);
  assert.match(s.status_detail, /collected 50 of 450/);
  assert.equal(s.unique_listings, CAP * PER_PAGE);
});

test('a price band too dense to split ends as capped, and the crawl terminates', async () => {
  const db = openDb(':memory:');
  const { fetcher } = cappedSite({ n: 200, prices: i => (i < 120 ? 500 : 100 + i * 10) }); // 120 ads at exactly 500 KM
  const s = await crawl(db, fetcher, SEARCH, quiet);
  assert.equal(s.status, 'capped', s.status_detail);
  assert.match(s.status_detail, /exceeded the 5-page cap/);
  assert.ok(s.unique_listings >= 130 && s.unique_listings < 200, `got ${s.unique_listings}`);
});

test('crawl with --max-pages stops and resumes across phases until complete', async () => {
  const db = openDb(':memory:');
  const { fetcher } = cappedSite();
  let s, rounds = 0;
  do { s = await crawl(db, fetcher, SEARCH, { ...quiet, maxPages: 7 }); rounds++; } while (s.status === 'stopped' && rounds < 50);
  assert.equal(s.status, 'complete');
  assert.equal(s.unique_listings, 450);
  assert.ok(rounds > 3);
});

test('a run an older version wrongly marked complete is reopened when the site reports more pages', async () => {
  const db = openDb(':memory:');
  const { fetcher } = cappedSite();
  // Simulate the old behaviour: complete after the first page of repeats (page 6 of 45).
  await crawl(db, fetcher, SEARCH, { ...quiet, maxPages: 6 });
  db.prepare(`UPDATE runs SET status='complete', status_detail='page contained no new listing IDs'`).run();
  assert.equal(db.prepare('SELECT new_listings FROM pages WHERE page=6').get().new_listings, 0);
  const s = await crawl(db, fetcher, SEARCH, quiet);
  assert.equal(s.status, 'complete');
  assert.equal(s.unique_listings, 450);
  // and a genuinely complete run is not re-crawled
  const before = db.prepare('SELECT pages_fetched p FROM runs').get().p;
  await crawl(db, fetcher, SEARCH, quiet);
  assert.equal(db.prepare('SELECT pages_fetched p FROM runs').get().p, before);
});
