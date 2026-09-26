import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearchPage } from '../src/extract.js';
import { rank, cpuScore, groupKey } from '../src/score.js';
import { parseCpu, extractSpecs } from '../src/specs.js';

const fx = f => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const listings = () => {
  const m = new Map();
  for (const f of ['search-page-1.html', 'search-page-2.html', 'api-search.json'])
    for (const l of parseSearchPage(fx(f)).listings) m.set(l.id, l);
  return [...m.values()];
};

test('CPU tiers are ordered sensibly', () => {
  const s = t => cpuScore({ ...parseCpu(t), source: 'title' }).score;
  assert.ok(s('i5-8350U') > s('i5-7200U'));
  assert.ok(s('i7-12700H') > s('i5-1135G7'));
  assert.ok(s('Ryzen 7 5800H') > s('Ryzen 5 5600U'));
  assert.ok(s('Celeron N4020') < s('i3-1115G4'));
  assert.equal(cpuScore({ ...parseCpu('Intel Core i5'), source: 'title' }).score, null);
  assert.equal(cpuScore(undefined).score, null);
});

test('ranking is deterministic and explainable', () => {
  const a = rank(listings()), b = rank(listings().reverse());
  assert.deepEqual(a.results.map(g => g.best.listing.id), b.results.map(g => g.best.listing.id));
  const first = a.results[0].best;
  for (const k of ['cpu', 'screen', 'build', 'ram', 'battery', 'value']) {
    assert.ok(k in first.components);
    assert.ok(first.components[k].evidence.length > 0, `evidence for ${k}`);
  }
  assert.deepEqual(Object.values(a.weights), [30, 24, 18, 13, 9, 6]);
});

test('unknowns are flagged and lower confidence', () => {
  const r = rank(listings());
  const vague = r.results.find(g => g.best.listing.id === '61000004').best;
  assert.equal(vague.components.cpu.score, null);
  assert.equal(vague.confidence, 0);
  assert.ok(vague.flags.some(f => /CPU performance unknown/.test(f)));
});

test('reordering priorities changes the ranking', () => {
  const top = p => rank(listings(), { priorities: p }).results[0].best.listing.id;
  assert.equal(top(['cpu', 'ram', 'build', 'value', 'screen', 'battery']), '61000008'); // Ryzen 7 5800H
  assert.equal(top(['value', 'build', 'ram', 'cpu', 'screen', 'battery']), '61000005'); // cheapest T480
  assert.equal(top(['screen', 'build', 'cpu', 'value', 'ram', 'battery']), '61000006'); // MacBook Retina
});

test('duplicate configurations are grouped, best offer listed first', () => {
  const r = rank(listings());
  const t480 = r.results.find(g => g.key.startsWith('lenovo thinkpad t480'));
  assert.deepEqual(t480.offers.map(o => o.listing.id), ['61000005', '61000001']);
  assert.equal(t480.offers[0].listing.price_km, 590);
  assert.equal(r.groups, r.passedFilters - 1);
  // uncertain configs never grouped
  assert.equal(groupKey(extractSpecs({ title: 'Lenovo laptop i5 8GB' }), 'x'), 'id:x');
});

test('hard filters: price, RAM, screen, condition, unknown handling', () => {
  const ids = f => rank(listings(), { filters: f }).results.flatMap(g => g.offers.map(o => o.listing.id)).sort();
  assert.ok(!ids({ priceMax: 1000 }).includes('61000002'));
  assert.ok(ids({ priceMax: 1000 }).includes('61000004')); // unknown price allowed by default
  assert.ok(!ids({ priceMax: 1000, allowUnknown: false }).includes('61000004'));
  assert.ok(ids({ ramMin: 16, allowUnknown: false }).every(id => !['61000002', '61000006', '61000007', '61000010'].includes(id)));
  assert.deepEqual(ids({ conditions: ['new'], allowUnknown: false }), ['61000003', '61000007']);
  const f = rank(listings(), { filters: { screenMin: 15, allowUnknown: true } }).results;
  const unk = f.flatMap(g => g.offers).find(o => o.listing.id === '61000004');
  assert.ok(unk.flags.some(x => /screen size unknown/.test(x)));
});

test('filter rejections are counted by reason so an empty result is explainable', () => {
  const r = rank(listings(), { filters: { screenMin: 15, allowUnknown: false } });
  assert.equal(r.passedFilters, 1); // only the 15.6" EliteBook states its size
  assert.equal(r.rejected.screen.unknown + r.rejected.screen.outOfRange, r.considered - 1);
  assert.ok(r.rejected.screen.unknown > 0);
  const none = rank(listings(), { filters: { priceMax: 10 } });
  assert.ok(none.rejected.price.outOfRange > 0);
});
