import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { Fetcher } from '../src/fetcher.js';
import { enrichShortlist, loadDemo, rankRun, exportResults } from '../src/app.js';

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));

test('enrichment fetches detail pages for the shortlist only, then re-ranks with description data', async () => {
  const db = openDb(':memory:');
  loadDemo(db, fixtures);
  db.prepare('UPDATE listings SET detail_fetched_at=NULL, description=NULL, attributes_json=NULL').run();
  const calls = [];
  const detail = readFileSync(join(fixtures, 'detail-61000001.html'), 'utf8');
  const transport = async url => {
    calls.push(url);
    return url.endsWith('robots.txt') ? { status: 404, body: '' } : { status: 200, body: detail };
  };
  const fetcher = new Fetcher({ cacheDir: mkdtempSync(join(tmpdir(), 'olxe-')), transport, delayMs: 0, jitterMs: 0, sleep: async () => {}, log: null });
  const r = await enrichShortlist(db, fetcher, { n: 2, log: () => {} });
  const listingCalls = calls.filter(c => c.includes('/artikal/'));
  // top 2 groups = T480 group (2 offers) + one more listing → exactly 3 detail pages out of 10 listings
  assert.equal(listingCalls.length, 3);
  assert.equal(r.done, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM listings WHERE detail_fetched_at IS NOT NULL').get().n, 3);
  const top = rankRun(db, {}).results[0].best;
  assert.ok(top.listing.detail_fetched_at);
  assert.notEqual(top.components.battery.score, null);
});

test('export writes JSON and CSV for the top results', () => {
  const db = openDb(':memory:');
  loadDemo(db, fixtures);
  const out = join(mkdtempSync(join(tmpdir(), 'olxx-')), 'res');
  const r = exportResults(db, { out, top: 50 });
  const json = JSON.parse(readFileSync(r.json, 'utf8'));
  assert.equal(json.results.length, r.count);
  const csv = readFileSync(r.csv, 'utf8').trim().split('\n');
  assert.equal(csv.length, r.count + 1);
  assert.match(csv[0], /"rank",.*"cpu_score".*"flags","url"/);
});
