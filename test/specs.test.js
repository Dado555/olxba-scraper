import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractSpecs, parseCpu, parseRam, parseStorage, parseScreenSize, parseWarranty, parseBattery, parseModel } from '../src/specs.js';
import { parseDetailPage } from '../src/extract.js';

const v = x => x?.value;

test('CPU parsing incl. generations', () => {
  assert.deepEqual([v(parseCpu('i5-8350U')).gen, v(parseCpu('Core i7 10510U')).gen, v(parseCpu('i5-1135G7')).gen,
    v(parseCpu('i7-12700H')).gen, v(parseCpu('i5 1235U')).gen, v(parseCpu('i7-4600M')).gen], [8, 10, 11, 12, 12, 4]);
  assert.equal(v(parseCpu('Ryzen 5 5600U')).model, 'Ryzen 5 5600U');
  assert.equal(v(parseCpu('AMD Ryzen 7 PRO 4750U')).gen, 4);
  assert.equal(v(parseCpu('Intel Core Ultra 7 155H')).family, 'Core Ultra 7');
  assert.equal(v(parseCpu('MacBook Pro M2 Pro 16GB')).model, 'Apple M2 Pro');
  assert.equal(v(parseCpu('Intel Core i5 laptop')).exact, false);
  assert.equal(v(parseCpu('Celeron N4020')).low, true);
  assert.equal(parseCpu('Laptop hitno prodajem'), null);
});

test('RAM vs storage disambiguation', () => {
  assert.equal(v(parseRam('i7-8650U 8GB 512 GB NVMe')), 8);
  assert.equal(v(parseRam('256GB SSD 16GB RAM')), 16);
  assert.equal(v(parseRam('RAM: 32 GB')), 32);
  assert.equal(parseRam('moguće proširenje do 64GB'), null);
  assert.equal(parseRam('512GB SSD'), null);
  assert.deepEqual(v(parseStorage('1TB NVMe')), { gb: 1024, type: 'SSD' });
  assert.deepEqual(v(parseStorage('500 GB HDD')), { gb: 500, type: 'HDD' });
  assert.deepEqual(v(parseStorage('256GB')), { gb: 256, type: null });
  assert.equal(parseStorage('16GB'), null);
});

test('screen size requires an unambiguous marker', () => {
  assert.equal(v(parseScreenSize('14" FHD')), 14);
  assert.equal(v(parseScreenSize('15,6 inch')), 15.6);
  assert.equal(v(parseScreenSize('HP 250 G8 15.6')), 15.6);
  assert.equal(parseScreenSize('Lenovo 14 i5'), null);
  assert.equal(parseScreenSize('baterija 14,5 h'), null);
});

test('warranty and battery', () => {
  assert.equal(v(parseWarranty('Garancija 6 mjeseci')).months, 6);
  assert.equal(v(parseWarranty('1 godina garancije')).months, 12);
  assert.equal(v(parseWarranty('bez garancije')).months, 0);
  assert.equal(v(parseWarranty('ima garanciju')).months, null);
  assert.equal(parseWarranty('odličan'), null);
  assert.equal(v(parseBattery('baterija drži oko 5h')).hours, 5);
  assert.equal(v(parseBattery('Zdravlje baterije 87%')).health_pct, 87);
  assert.equal(v(parseBattery('baterija slaba')).weak, true);
});

test('model extraction', () => {
  assert.equal(v(parseModel('Dell Latitude 7490 Intel Core i7-8650U')).name, 'Dell Latitude 7490');
  assert.equal(v(parseModel('ThinkPad T14 Gen 2 i5')).name, 'Lenovo ThinkPad T14 Gen 2');
  assert.equal(v(parseModel('Asus VivoBook 15 Celeron')).exact, false);
  assert.equal(parseModel('Laptop hitno prodajem'), null);
});

test('unknown values stay unknown (no invented specs)', () => {
  const s = extractSpecs({ title: 'Laptop hitno prodajem' });
  for (const k of ['cpu', 'ram_gb', 'storage', 'screen_in', 'resolution', 'model', 'battery', 'warranty', 'condition'])
    assert.equal(s[k], undefined, k);
});

test('description + attribute table enrich the title', () => {
  const d = parseDetailPage(readFileSync(new URL('./fixtures/detail-61000001.html', import.meta.url), 'utf8'));
  const s = extractSpecs({ title: d.title, description: d.description, attributes: d.attributes });
  assert.equal(s.ram_gb.source, 'attributes');
  assert.equal(s.warranty.value.months, 3);
  assert.equal(s.warranty.source, 'description');
  assert.equal(s.battery.value.hours, 6);
  assert.equal(s.ram_upgradable.value, true);
  assert.equal(s.backlit.value, true);
  assert.equal(s.condition.value, 'used');
  // description gives exact CPU when title only says "i5"
  const s2 = extractSpecs({ title: 'Lenovo laptop i5 8GB', description: 'Procesor Intel Core i5-10210U, 4 jezgre' });
  assert.equal(s2.cpu.value.model, 'i5-10210U'); assert.equal(s2.cpu.source, 'description');
  // conflict is recorded, attributes win
  const s3 = extractSpecs({ title: 'HP 8GB RAM', attributes: { RAM: '16 GB' } });
  assert.equal(s3.ram_gb.value, 16); assert.equal(s3.conflicts.length, 1);
});

test('weight, ports and CPU conflicts (inputs for mobility/connectivity/ambiguity)', async () => {
  const { parseWeight, parsePorts, allExactCpuModels } = await import('../src/specs.js');
  assert.equal(parseWeight('težina 1,4 kg').value, 1.4);
  assert.equal(parseWeight('dostava 10 kg'), null);
  assert.equal(parseWeight('bez podataka'), null);
  assert.deepEqual(parsePorts('2x Thunderbolt 3, HDMI, RJ45, WiFi 6'), ['Thunderbolt/USB4', 'HDMI', 'Ethernet', 'Wi-Fi 6+']);
  assert.deepEqual(parsePorts('USB-C punjenje'), ['USB-C']);
  assert.deepEqual(parsePorts('Lenovo T480'), []);
  assert.deepEqual(allExactCpuModels('i5-8350U ili i7-8650U'), ['i5-8350u', 'i7-8650u']);
  assert.equal(extractSpecs({ title: 'Dell i5-8350U 8GB' }).cpu_conflict, undefined);
});
