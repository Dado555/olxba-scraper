import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { Fetcher, parseRobots } from '../src/fetcher.js';
import { crawl } from '../src/crawl.js';

const fx = f => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const SEARCH = 'https://olx.ba/pretraga?category_id=39&attr=ram(16)';

function fakeSite(overrides = {}) {
  const calls = [];
  const transport = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nDisallow: /profil/\n' };
    const page = u.searchParams.get('page') || '1';
    if (overrides[page]) return overrides[page]();
    assert.equal(u.searchParams.get('attr'), 'ram(16)', 'filters must be preserved');
    assert.equal(u.searchParams.get('category_id'), '39');
    const body = { '1': fx('search-page-1.html'), '2': fx('search-page-2.html') }[page] ?? fx('search-empty.html');
    return { status: 200, body };
  };
  const fetcher = new Fetcher({ cacheDir: mkdtempSync(join(tmpdir(), 'olxc-')), transport, delayMs: 0, jitterMs: 0,
    sleep: async () => {}, log: null });
  return { calls, fetcher };
}

test('2-page smoke crawl: pagination, dedup, stop at max-pages, resume, complete', async () => {
  const db = openDb(':memory:');
  const { calls, fetcher } = fakeSite();
  let s = await crawl(db, fetcher, SEARCH, { maxPages: 2, log: () => {} });
  assert.equal(s.status, 'stopped');
  assert.equal(s.next_page, 3);
  assert.equal(s.unique_listings, 8); // 5 + 4, one duplicate across pages
  assert.equal(db.prepare('SELECT COUNT(*) n FROM listings').get().n, 8);
  assert.deepEqual(calls.map(c => new URL(c).searchParams.get('page')), [null, null, '2']); // robots, p1, p2
  // resume: page 3 is empty -> complete
  s = await crawl(db, fetcher, SEARCH, { log: () => {} });
  assert.equal(s.status, 'complete');
  assert.equal(s.status_detail, 'empty page reached');
  assert.equal(s.unique_listings, 8);
  // once complete, a rerun makes no requests
  const before = calls.length;
  await crawl(db, fetcher, SEARCH, { log: () => {} });
  assert.equal(calls.length, before);
});

test('stops (resumably) on captcha, never retries', async () => {
  const db = openDb(':memory:');
  const { calls, fetcher } = fakeSite({ '2': () => ({ status: 200, body: fx('captcha.html') }) });
  const s = await crawl(db, fetcher, SEARCH, { log: () => {} });
  assert.equal(s.status, 'blocked');
  assert.equal(s.next_page, 2);
  assert.equal(s.unique_listings, 5);
  assert.equal(calls.filter(c => c.includes('page=2')).length, 1);
});

test('stops on HTTP 429', async () => {
  const db = openDb(':memory:');
  const { fetcher } = fakeSite({ '1': () => ({ status: 429, body: '' }) });
  const s = await crawl(db, fetcher, SEARCH, { log: () => {} });
  assert.equal(s.status, 'blocked');
  assert.match(s.status_detail, /429/);
});

test('robots.txt evaluation', () => {
  const allowed = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /api/\nAllow: /api/search\nDisallow: /*?sort=\n');
  assert.equal(allowed('https://olx.ba/pretraga?q=x'), true);
  assert.equal(allowed('https://olx.ba/api/listings/1'), false);
  assert.equal(allowed('https://olx.ba/api/search?page=1'), true);
  assert.equal(allowed('https://olx.ba/pretraga?sort=asc'), false);
});
