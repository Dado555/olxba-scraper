import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCpuName, buildBenchmarkTable, parseBenchmarkFile, parseLaunch, fetchPassmark, loadBenchmarks } from '../src/cpu-db.js';
import { cpuScore, cpuKey, yearInfo, rank, SORTS } from '../src/score.js';
import { extractSpecs } from '../src/specs.js';
import { modelYear, loadModelOverrides, modelOverride } from '../src/models.js';
import { parseYear } from '../src/specs.js';

const rows = parseBenchmarkFile(readFileSync(new URL('./fixtures/passmark-synthetic.json', import.meta.url), 'utf8'));
const table = buildBenchmarkTable(rows, { fetchedAt: 'test' });
const specs = t => extractSpecs({ title: t });

test('benchmark names normalise to the keys the listing parser produces', () => {
  const same = (name, title) => assert.equal(normalizeCpuName(name)?.key, cpuKey(specs(title).cpu.value), `${name} vs ${title}`);
  same('Intel Core i5-8350U @ 1.70GHz', 'ThinkPad i5-8350U');
  same('Intel Core i5-1135G7 @ 2.40GHz', 'HP i5-1135G7 16GB');
  same('AMD Ryzen 7 5800H', 'Legion Ryzen 7 5800H');
  same('Intel Core Ultra 7 155H', 'Intel Core Ultra 7 155H 32GB');
  same('Apple M1 Pro 10 Core 3200 MHz', 'MacBook Pro M1 Pro 16GB');
  same('Intel Celeron N4020 @ 1.10GHz', 'Asus Celeron N4020');
  assert.equal(normalizeCpuName('AMD Ryzen 7 PRO 5850U').variant, 'pro');
  assert.equal(normalizeCpuName('Some Unknown CPU X'), null);
});

test('table build: number/date parsing, PRO fallback, ambiguity, fixed reference', () => {
  assert.deepEqual(table.cpus['i5-8350u'], { name: 'Intel Core i5-8350U @ 1.70GHz', single: 2000, multi: 6000, released: '2017-08', laptop: true });
  assert.equal(table.cpus['ryzen 5 5600u'].multi, 15000);                 // plain entry preferred over PRO
  assert.equal(table.cpus['ryzen 7 5850u'].multi, 18000);                 // PRO used when it is the only one
  assert.equal(table.cpus['apple m1 pro'].ambiguous, true);               // 8- vs 10-core differ > 10 %
  assert.equal(table.cpus['apple m1'].released, '2020-11');
  assert.ok(table.reference.single > 0 && table.reference.multi > 0);
  assert.equal(parseLaunch('Q3 2017'), '2017-07');
  assert.equal(parseLaunch('NA'), null);
  const csv = parseBenchmarkFile('name,cpumark,thread,date\n"Intel Core i5-8350U @ 1.70GHz","6,000",2000,Aug 2017\n');
  assert.equal(buildBenchmarkTable(csv).cpus['i5-8350u'].multi, 6000);
});

test('CPU score uses the benchmark table: verified, monotonic, ambiguous stays unknown', () => {
  const s = t => cpuScore(specs(t).cpu, { benchmarks: table });
  const a = s('ThinkPad i5-8350U'), b = s('Legion Ryzen 7 5800H'), c = s('Asus Celeron N4020');
  assert.equal(a.basis, 'verified');
  assert.ok(a.evidence.some(e => /single-thread 2000/.test(e)));
  assert.ok(b.score > a.score && a.score > c.score);
  const amb = s('MacBook Pro M1 Pro 16GB');
  assert.equal(amb.score, null);
  assert.ok(amb.flags.includes('CPU benchmark ambiguous'));
  assert.equal(s('Dell i7-10510U').basis, 'estimate'); // not in table → tier estimate, never a made-up number
  assert.equal(s('Laptop Intel Core i7').score, null);
});

test('loadBenchmarks reads an explicit table file and re-reads it when it changes', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'cpu-')), 't.json');
  writeFileSync(p, JSON.stringify(table));
  assert.equal(Object.keys(loadBenchmarks({ path: p }).cpus).length, Object.keys(table.cpus).length);
  writeFileSync(p, JSON.stringify({ ...table, cpus: {} }));
  const later = new Date(Date.now() + 5000);
  utimesSync(p, later, later);
  assert.equal(Object.keys(loadBenchmarks({ path: p }).cpus).length, 0);
});

test('fetchPassmark: robots, cookie hand-off, block detection', async () => {
  const body = JSON.stringify({ data: rows });
  const calls = [];
  const http = async (url, opts) => {
    calls.push([url, opts]);
    if (url.endsWith('robots.txt')) return { status: 200, body: 'User-agent: *\nDisallow: /cgi-bin/\n' };
    if (url.includes('mega_page')) return { status: 200, body: '<html>list</html>', cookie: 'sid=abc' };
    return { status: 200, body };
  };
  const got = await fetchPassmark({ http, sleep: async () => {}, log: () => {} });
  assert.equal(got.length, rows.length);
  assert.equal(calls[2][1].cookie, 'sid=abc');
  assert.equal(calls[2][1].xhr, true);
  await assert.rejects(fetchPassmark({ http: async u => u.endsWith('robots.txt') ? { status: 200, body: 'User-agent: *\nDisallow: /data/\n' } : http(u, {}), sleep: async () => {}, log: () => {} }), /disallows/);
  await assert.rejects(fetchPassmark({ http: async u => u.endsWith('robots.txt') ? { status: 404, body: '' } : { status: 200, body: '<title>Just a moment...</title>' }, sleep: async () => {}, log: () => {} }), /captcha/);
});

test('manufacture year: stated > model rule > CPU launch lower bound', () => {
  const y = t => yearInfo(specs(t), table, []);
  assert.deepEqual([y('Apple MacBook Pro 2019 16GB').value, y('Apple MacBook Pro 2019 16GB').basis], [2019, 'stated']);
  assert.deepEqual([y('Lenovo ThinkPad T480 i5-8350U').value, y('Lenovo ThinkPad T480 i5-8350U').basis], [2018, 'model']);
  assert.deepEqual([y('Dell Latitude 7490 i7-8650U').value, y('HP EliteBook 840 G8 i5-1135G7').value], [2018, 2021]);
  const cpuOnly = y('Lenovo laptop i5-1135G7 8GB');
  assert.deepEqual([cpuOnly.value, cpuOnly.basis], [2020, 'cpu']);
  assert.match(cpuOnly.evidence, /not before 2020-09/);
  assert.equal(y('Laptop hitno').value, null);
  const p = y('Laptop kupljen 2021');
  assert.equal(p.value, null); assert.equal(p.upTo, 2021);
  assert.ok(y('ThinkPad i5-1135G7 model 2018').flags.some(f => /before the CPU launch/.test(f)));
  assert.equal(modelYear('Lenovo ThinkPad X1 Carbon Gen 7')?.year, 2019);
  assert.equal(modelYear('Lenovo ThinkPad T14 Gen 2')?.year, 2021);
  assert.equal(modelYear('Asus VivoBook 15'), null);
  assert.equal(parseYear('RTX 2060 laptop'), null);
});

test('your laptop-models.json: year and build rating override; display only for the rated resolution', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'lm-')), 'm.json');
  writeFileSync(p, JSON.stringify([{ match: 'thinkpad t480', year: 2018, build: 90, display: 75, resolution: 'FHD', source: 'my notes' }]));
  const ov = loadModelOverrides({ path: p, fresh: true });
  assert.equal(modelOverride('Lenovo ThinkPad T480', ov).build, 90);
  const r = rank([{ id: '1', url: 'u', title: 'Lenovo ThinkPad T480 i5-8350U 16GB 256GB SSD 14" FHD', price_km: 600, tags: [] },
    { id: '2', url: 'u', title: 'Lenovo ThinkPad T480 i5-8350U 16GB 256GB SSD 14" 1366x768', price_km: 500, tags: [] }],
  { overrides: ov, benchmarks: table });
  const by = id => r.results.flatMap(g => g.offers).find(o => o.listing.id === id);
  assert.match(by('1').components.build.evidence[0], /your rating/);
  assert.equal(by('1').components.screen.score, 75);
  assert.equal(by('2').components.screen.score, 20); // HD panel: rating for the FHD config not applied
  loadModelOverrides({ fresh: true });
});

test('sorting the top list by year, price, cpu, display, build keeps score rank and puts unknowns last', () => {
  const L = (id, t, p) => ({ id, url: 'u', title: t, price_km: p, tags: [] });
  const ls = [L('a', 'Lenovo ThinkPad T480 i5-8350U 16GB 256GB 14" FHD IPS', 650), L('b', 'HP EliteBook 840 G8 i5-1135G7 16GB 512GB', 1200),
    L('c', 'Legion 5 Ryzen 7 5800H 16GB 1TB', 1900), L('d', 'Laptop hitno', null), L('e', 'Asus VivoBook Celeron N4020 4GB', 300)];
  const ids = sort => rank(ls, { sort, benchmarks: table, overrides: [] }).results.map(g => g.best.listing.id);
  const byScore = rank(ls, { benchmarks: table, overrides: [] }).results;
  assert.deepEqual(Object.keys(SORTS), ['score', 'year', 'price', 'cpu', 'screen', 'build']);
  assert.deepEqual(ids('price'), ['e', 'a', 'b', 'c', 'd']);
  assert.equal(ids('cpu')[0], 'c');
  assert.equal(ids('cpu').at(-1), 'd');
  assert.equal(ids('year')[0], 'c');                // 2021 (CPU launch) ties b (2021 model); score rank breaks the tie
  assert.equal(ids('screen')[0], 'a');
  const sorted = rank(ls, { sort: 'price', benchmarks: table, overrides: [] }).results;
  for (const g of sorted) assert.equal(g.rank, byScore.find(x => x.best.listing.id === g.best.listing.id).rank);
});
