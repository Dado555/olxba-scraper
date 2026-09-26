import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePrice, parseSearchPage, parseDetailPage, detectBlock } from '../src/extract.js';
import { normalizeSearchUrl, pageUrl, listingIdFromHref, apiSearchUrl } from '../src/url.js';

const fx = f => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('price parsing', () => {
  assert.equal(parsePrice('650 KM').km, 650);
  assert.equal(parsePrice('1.150 KM').km, 1150);
  assert.equal(parsePrice('1 899,50 KM').km, 1899.5);
  assert.equal(parsePrice('12.500 KM').km, 12500);
  assert.equal(parsePrice('500 €').km, 978);
  const d = parsePrice('Po dogovoru');
  assert.equal(d.km, null); assert.equal(d.negotiable, true);
  assert.equal(parsePrice('0 KM').km, null);
  assert.equal(parsePrice('').km, null);
});

test('URL: preserves all filters and only changes page', () => {
  const base = normalizeSearchUrl('https://www.olx.ba/pretraga?category_id=39&attr=ram(16)&attr=x(1)&price_to=1500&page=4#top');
  assert.equal(base, 'https://www.olx.ba/pretraga?category_id=39&attr=ram%2816%29&attr=x%281%29&price_to=1500');
  const p3 = new URL(pageUrl(base, 3));
  assert.deepEqual(p3.searchParams.getAll('attr'), ['ram(16)', 'x(1)']);
  assert.equal(p3.searchParams.get('price_to'), '1500');
  assert.equal(p3.searchParams.get('page'), '3');
  assert.equal(new URL(pageUrl(base, 1)).searchParams.has('page'), false);
  assert.equal(new URL(apiSearchUrl(base, 2)).pathname, '/api/search');
  assert.throws(() => normalizeSearchUrl('https://example.com/?q=1'));
  assert.equal(listingIdFromHref('/artikal/61000003/hp-elitebook'), '61000003');
  assert.equal(listingIdFromHref('/profil/abc'), null);
});

test('search page 1 extraction', () => {
  const r = parseSearchPage(fx('search-page-1.html'));
  assert.equal(r.listings.length, 5);
  assert.equal(r.lastPage, 3);
  const [a, b, c, d] = r.listings;
  assert.equal(a.id, '61000001');
  assert.match(a.title, /ThinkPad T480/);
  assert.equal(a.price_km, 650); assert.equal(a.condition, 'used');
  assert.equal(b.price_km, 1150);
  assert.equal(c.price_km, 1899.5); assert.equal(c.condition, 'new');
  assert.equal(d.price_km, null); assert.equal(d.negotiable, true); assert.equal(d.condition, null);
});

test('search page 2 + empty page + JSON API', () => {
  const r = parseSearchPage(fx('search-page-2.html'));
  assert.deepEqual(r.listings.map(l => l.id), ['61000002', '61000006', '61000007', '61000008']);
  assert.equal(parseSearchPage(fx('search-empty.html')).listings.length, 0);
  const j = parseSearchPage(fx('api-search.json'));
  assert.equal(j.lastPage, 1);
  assert.equal(j.listings[0].price_km, 1700);
  assert.equal(j.listings[0].condition, 'used');
  assert.equal(j.listings[1].price_km, null);
});

test('detail page: attributes and description', () => {
  const d = parseDetailPage(fx('detail-61000001.html'));
  assert.equal(d.attributes.RAM, '16 GB');
  assert.equal(d.attributes.Stanje, 'Korišteno');
  assert.match(d.description, /dva slota/);
  assert.equal(d.price_km, 650);
});

test('block detection', () => {
  assert.ok(detectBlock(200, fx('captcha.html')));
  assert.ok(detectBlock(429, ''));
  assert.equal(detectBlock(200, fx('search-page-1.html')), null);
});
