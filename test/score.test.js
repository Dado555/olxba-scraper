import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearchPage } from '../src/extract.js';
import { rank, cpuScore, groupKey, COMPONENTS, resolveWeights, scoreListings, scoreRow, UNKNOWN_SCORE, ramScore, screenScore,
  buildScore, batteryScore, connectivityScore, DEFAULT_BENCHMARKS, affordability, rankBestValue, rankBestWithinBudget } from '../src/score.js';
import { parseCpu, extractSpecs } from '../src/specs.js';

const fx = f => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const L = (title, price_km, extra = {}) => ({ id: title.slice(0, 20) + price_km, url: 'u', title, price_km, tags: [], ...extra });
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
  assert.deepEqual(a.results.map(g => g.best.total), b.results.map(g => g.best.total));
  const first = a.results[0].best;
  for (const k of Object.keys(COMPONENTS)) {
    assert.ok(first.components[k].evidence.length > 0, `evidence for ${k}`);
    assert.ok(['verified', 'estimate', 'partial', 'unknown'].includes(first.components[k].basis));
  }
});

test('default weights are 25/20/20/15/10/10 and follow the drag order', () => {
  assert.deepEqual(resolveWeights(), { ram: 25, cpu: 20, screen: 20, build: 15, battery: 10, connectivity: 10 });
  assert.deepEqual(resolveWeights(['connectivity', 'ram']), { connectivity: 25, ram: 20, cpu: 20, screen: 15, build: 10, battery: 10 });
  // explicit weights are normalised to 100
  const w = resolveWeights(undefined, { ram: 1, cpu: 1, screen: 0, build: 0, battery: 0, connectivity: 2 });
  assert.deepEqual(w, { ram: 25, cpu: 25, screen: 0, build: 0, battery: 0, connectivity: 50 });
  // unknown keys (e.g. an old saved "value" priority) are ignored
  assert.deepEqual(Object.keys(resolveWeights(['value', 'cpu'])), ['cpu', 'ram', 'screen', 'build', 'battery', 'connectivity']);
});

test('quality score = weighted sum of components with unknowns at UNKNOWN_SCORE', () => {
  const [row] = scoreListings([L('Lenovo ThinkPad T480 i5-8350U 16GB 512GB SSD 14" FHD IPS', 800)]);
  const w = resolveWeights();
  scoreRow(row, w);
  const expected = Object.entries(w).reduce((a, [k, wt]) => a + wt * (row.components[k].score ?? UNKNOWN_SCORE), 0) / 100;
  assert.equal(row.quality, Math.round(expected * 10) / 10);
  assert.ok(row.qualityRange[0] <= row.quality && row.quality <= row.qualityRange[1]);
  assert.equal(row.total, row.quality); // quality mode
});

test('RAM curve has diminishing returns and is monotonic', () => {
  const s = gb => ramScore(extractSpecs({ title: `Laptop ${gb}GB RAM 512GB SSD` })).score;
  const [a, b, c, d] = [s(8), s(16), s(32), s(64)];
  assert.ok(a < b && b < c && c <= d);
  assert.ok(b - a > d - c, 'gain 8→16 must exceed gain 32→64');
  assert.equal(ramScore(extractSpecs({ title: 'Laptop i5' })).score, null);
});

test('improving a verified beneficial spec never lowers quality', () => {
  const q = t => { const [r] = scoreListings([L(t, 900)]); return scoreRow(r, resolveWeights()).quality; };
  const base = 'Dell Latitude 7490 i5-8350U 8GB 256GB SSD 14" FHD';
  assert.ok(q(base.replace('8GB', '16GB')) >= q(base));
  assert.ok(q(base.replace('8GB', '32GB')) >= q(base.replace('8GB', '16GB')));
  assert.ok(q(base.replace('256GB', '512GB')) >= q(base));
  assert.ok(q(base.replace('FHD', 'FHD IPS')) >= q(base));
  assert.ok(q(base.replace('FHD', 'QHD')) >= q(base));
  assert.ok(q(base + ' garancija 12 mjeseci') >= q(base + ' garancija 3 mjeseca'));
});

test('unknown panel / keyboard / battery / upgrade path never earn a premium', () => {
  const noPanel = screenScore(extractSpecs({ title: 'HP 15.6 FHD' })).score;
  const ips = screenScore(extractSpecs({ title: 'HP 15.6 FHD IPS' })).score;
  assert.ok(noPanel < ips);
  assert.equal(screenScore(extractSpecs({ title: 'Lenovo ThinkPad T480 IPS' })).score, null); // panel without resolution
  const unstated = ramScore(extractSpecs({ title: '16GB RAM' })).score;
  assert.ok(unstated < ramScore(extractSpecs({ title: '16GB RAM, dva slota' })).score);
  assert.equal(batteryScore(extractSpecs({ title: 'ThinkPad T480' })).score, null);
  assert.equal(connectivityScore(extractSpecs({ title: 'ThinkPad T480' })).score, null);
  const b = buildScore(extractSpecs({ title: 'Lenovo ThinkPad T480' }));
  assert.equal(b.basis, 'estimate'); // family table is never presented as a verified fact
  assert.equal(buildScore(extractSpecs({ title: 'Laptop 16GB' })).score, null);
});

test('CPU: exact model only; family-only and ambiguous CPUs stay unknown', () => {
  const c = t => { const s = extractSpecs({ title: t }); return cpuScore(s.cpu, { conflict: s.cpu_conflict }); };
  assert.equal(c('Laptop Intel Core i7 16GB').score, null);
  assert.equal(c('Laptop Ryzen 7 16GB').score, null);
  assert.equal(c('Laptop i7 11th gen 8 jezgri').score, null);
  const amb = c('Dell Latitude i5-8350U / i7-8650U 16GB');
  assert.equal(amb.score, null);
  assert.ok(amb.flags.includes('CPU ambiguous'));
  const s = extractSpecs({ title: 'Dell i5-8350U', description: 'procesor i7-8650U' });
  assert.ok(s.cpu_conflict, 'title vs description disagreement is ambiguous');
  assert.equal(c('ThinkPad i5-8350U').basis, 'estimate');
});

test('CPU: benchmark table is used when it has the exact model', () => {
  const benchmarks = { reference: { single: 100, multi: 400 }, units: { single: 'pts', multi: 'pts' }, source: 'test table',
    cpus: { 'i5-8350u': { single: 100, multi: 400 }, 'ryzen 7 5800h': { single: 150, multi: 1200 } } };
  const t480 = cpuScore(extractSpecs({ title: 'i5-8350U' }).cpu, { benchmarks });
  assert.equal(t480.basis, 'verified');
  assert.equal(t480.score, 50); // equal to reference → 50
  const legion = cpuScore(extractSpecs({ title: 'Ryzen 7 5800H' }).cpu, { benchmarks });
  assert.ok(legion.score > t480.score && legion.score < 100);
  // not in table → estimate, never a made-up benchmark
  assert.equal(cpuScore(extractSpecs({ title: 'i5-1135G7' }).cpu, { benchmarks }).basis, 'estimate');
  assert.deepEqual(DEFAULT_BENCHMARKS.cpus, {}, 'shipped table must stay empty until filled from a real source');
});

test('scores are independent of other ads in the batch', () => {
  const all = listings();
  const target = id => rank(all.filter(Boolean)).results.flatMap(g => g.offers).find(o => o.listing.id === id);
  const before = target('61000001');
  const changed = all.map(l => l.id === '61000002' ? { ...l, price_km: 99, title: l.title + ' 64GB RAM' } : l);
  const after = rank(changed).results.flatMap(g => g.offers).find(o => o.listing.id === '61000001');
  assert.equal(after.total, before.total);
  assert.equal(after.quality, before.quality);
  for (const mode of ['value']) {
    const x = rank(all, { mode }).results.flatMap(g => g.offers).find(o => o.listing.id === '61000001');
    const y = rank(changed, { mode }).results.flatMap(g => g.offers).find(o => o.listing.id === '61000001');
    assert.equal(x.total, y.total);
  }
});

test('price sensitivity: cheaper never lowers Best Value; quality mode ignores price', () => {
  const t = 'Lenovo ThinkPad T480 i5-8350U 16GB 256GB SSD 14" FHD';
  const score = (p, mode) => rank([L(t, p)], { mode }).results[0].best;
  let prev = -1;
  for (const p of [3000, 2000, 1500, 1000, 700, 400, 100]) {
    const v = score(p, 'value').total;
    assert.ok(v >= prev, `value at ${p} KM (${v}) must be >= value at higher price (${prev})`);
    prev = v;
  }
  assert.equal(score(2000, 'quality').total, score(500, 'quality').total);
  const b = score(1000, 'value');
  assert.equal(b.total, Math.round((0.8 * b.quality + 0.2 * affordability(1000)) * 10) / 10);
  const unknownPrice = rank([L(t, null)], { mode: 'value' }).results[0].best;
  assert.ok(unknownPrice.flags.some(f => /price unknown/.test(f)));
  assert.equal(rankBestValue([L(t, 800)]).mode, 'value');
  assert.equal(rankBestWithinBudget([L(t, 800)]).mode, 'quality');
});

test('modes: value mode can reorder, quality mode ranks by quality only', () => {
  const q = rank(listings(), { mode: 'quality' }).results.map(g => g.best);
  for (let i = 1; i < q.length; i++) assert.ok(q[i - 1].quality >= q[i].quality);
  const v = rank(listings(), { mode: 'value' }).results.map(g => g.best);
  const pos = (arr, id) => arr.findIndex(x => x.listing.id === id);
  assert.ok(pos(v, '61000007') < pos(q, '61000007'), 'cheap Celeron moves up in value mode');
});

test('reordering priorities changes the ranking', () => {
  const top = p => rank(listings(), { priorities: p }).results[0].best.listing.id;
  assert.equal(top(['cpu', 'ram', 'build', 'screen', 'battery', 'connectivity']), '61000008'); // Ryzen 7 5800H
  assert.equal(top(['screen', 'build', 'cpu', 'ram', 'battery', 'connectivity']), '61000009'); // X1 Carbon WQHD
});

test('unknown-everything ad gets exactly the unknown baseline and a full uncertainty range', () => {
  const vague = rank(listings()).results.find(g => g.best.listing.id === '61000004').best;
  assert.equal(vague.quality, UNKNOWN_SCORE);
  assert.deepEqual(vague.qualityRange, [0, 100]);
  assert.equal(vague.certainty.unknown, 100);
  assert.equal(vague.confidence, 0);
});

test('hard filters exclude out-of-range listings; unknowns are marked needs verification', () => {
  const ids = f => rank(listings(), { filters: f }).results.flatMap(g => g.offers.map(o => o.listing.id)).sort();
  assert.ok(!ids({ priceMax: 1000 }).includes('61000002'));
  assert.ok(ids({ priceMax: 1000 }).includes('61000004'));
  assert.ok(!ids({ priceMax: 1000, allowUnknown: false }).includes('61000004'));
  assert.ok(ids({ ramMin: 16, allowUnknown: false }).every(id => !['61000002', '61000006', '61000007', '61000010'].includes(id)));
  assert.deepEqual(ids({ conditions: ['new'], allowUnknown: false }), ['61000003', '61000007']);
  const r = rank(listings(), { filters: { screenMin: 15, ramMin: 16, allowUnknown: true } });
  const unk = r.results.flatMap(g => g.offers).find(o => o.listing.id === '61000004');
  assert.deepEqual(unk.needsVerification, ['RAM', 'screen size']);
  assert.ok(unk.flags.includes('needs verification: RAM not stated (hard filter)'));
  // a listing failing a known constraint never appears, whatever its quality
  assert.ok(!r.results.flatMap(g => g.offers).some(o => o.listing.id === '61000009')); // 14" X1 Carbon
});

test('filter rejections are counted by reason so an empty result is explainable', () => {
  const r = rank(listings(), { filters: { screenMin: 15, allowUnknown: false } });
  assert.equal(r.passedFilters, 1);
  assert.ok(r.rejected.screen.unknown > 0);
  assert.ok(rank(listings(), { filters: { priceMax: 10 } }).rejected.price.outOfRange > 0);
});

test('only verified identical configurations are grouped', () => {
  const r = rank(listings());
  const t480 = r.results.find(g => g.key.startsWith('lenovo thinkpad t480'));
  assert.deepEqual(t480.offers.map(o => o.listing.id), ['61000005', '61000001']);
  // same model family, different/unknown storage or resolution → separate
  const k = t => groupKey(extractSpecs({ title: t }), t);
  assert.notEqual(k('Lenovo ThinkPad T480 i5-8350U 16GB 256GB SSD FHD'), k('Lenovo ThinkPad T480 i5-8350U 16GB 256GB SSD'));
  assert.equal(k('Lenovo ThinkPad T480 i5-8350U 16GB').startsWith('id:'), true); // storage unknown
  assert.equal(k('Lenovo ThinkPad i5-8350U 16GB 256GB').startsWith('id:'), true); // series only
  assert.equal(k('Lenovo laptop i5 8GB').startsWith('id:'), true);
});
