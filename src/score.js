// Deterministic, explainable scoring. Each component returns {score 0-100 | null, evidence[], flags[]}.
// null = unknown; ranking substitutes a fixed pessimistic value and flags it, never guesses.
import { extractSpecs } from './specs.js';

export const COMPONENTS = {
  cpu: 'CPU performance',
  screen: 'Screen quality',
  build: 'Keyboard / build comfort',
  ram: 'RAM / upgradeability',
  battery: 'Battery',
  value: 'Value for money',
};
export const DEFAULT_PRIORITIES = ['cpu', 'value', 'screen', 'build', 'ram', 'battery'];
export const POSITION_WEIGHTS = [30, 24, 18, 13, 9, 6]; // sums to 100
export const UNKNOWN_SCORE = 30; // used for unknown components in the total; always flagged

// Coarse relative CPU tiers (NOT benchmarks). Base = mid-tier (i5 / Ryzen 5) U-series of that generation.
const INTEL_GEN_BASE = { 1: 6, 2: 10, 3: 13, 4: 16, 5: 18, 6: 21, 7: 23, 8: 36, 9: 38, 10: 42, 11: 50, 12: 62, 13: 66, 14: 68, ultra1: 70, ultra2: 74 };
const AMD_GEN_BASE = { 2: 28, 3: 31, 4: 48, 5: 55, 6: 60, 7: 58, 8: 72, 9: 74 };
const TIER_MULT = { 3: 0.75, 5: 1, 7: 1.12, 9: 1.28 };
const APPLE_BASE = { 1: 62, 2: 68, 3: 74, 4: 80 };

export function cpuScore(cpu) {
  if (!cpu) return unknown('CPU not stated');
  const c = cpu.value;
  if (!c.exact && !c.low) return unknown(`only CPU family known ("${cpu.evidence}"), generation unknown`, [`CPU: ${c.family}`]);
  let base, why;
  if (c.low) { base = 10; why = `${c.model}: low-power Celeron/Pentium/Athlon class`; }
  else if (c.nseries) { base = 24; why = `${c.model}: Intel N-series`; }
  else if (c.vendor === 'Apple') {
    base = APPLE_BASE[c.gen] ?? 70;
    const mult = c.variant === 'max' ? 1.4 : c.variant === 'pro' ? 1.28 : 1;
    base *= mult; why = `${c.model}: Apple Silicon gen ${c.gen}${mult > 1 ? ` ×${mult}` : ''}`;
  } else if (c.vendor === 'Intel') {
    base = INTEL_GEN_BASE[c.gen];
    if (base == null) return unknown(`unrecognised Intel generation for ${c.model}`);
    const s = c.suffix || '';
    const sm = /^HX/.test(s) ? 1.5 : /^H/.test(s) ? 1.3 : /^P/.test(s) ? 1.12 : /^Y/.test(s) ? 0.7 : /^M/.test(s) && c.gen < 8 ? 1.05 : 1;
    const tm = TIER_MULT[c.tier] ?? 1;
    why = `${c.model}: Intel gen ${c.gen} base ${base} × tier ${tm} × suffix ${s || '-'} ${sm}`;
    base = base * tm * sm;
  } else {
    let g = AMD_GEN_BASE[c.gen];
    if (c.gen === 7 && c.sub != null) g = c.sub >= 4 ? 68 : c.sub === 3 ? 55 : 40; // 7x40=Zen4, 7x30=Zen3, 7x20=Zen2
    if (g == null) return unknown(`unrecognised AMD series for ${c.model}`);
    const s = c.suffix || '';
    const sm = /^HX/.test(s) ? 1.45 : /^H/.test(s) ? 1.3 : 1;
    const tm = TIER_MULT[c.tier] ?? 1;
    why = `${c.model}: Ryzen ${c.gen}000 base ${g} × tier ${tm} × suffix ${s || '-'} ${sm}`;
    base = g * tm * sm;
  }
  return known(base, [`${why} (source: ${cpu.source} "${cpu.evidence}")`]);
}

const RES_SCORE = { HD: 20, FHD: 60, WUXGA: 66, QHD: 78, Retina: 82, '3K': 85, '4K': 88 };
export function screenScore(s) {
  const ev = [], flags = [];
  if (!s.resolution) return unknown('resolution not stated', s.panel ? [`panel ${s.panel.value}`] : []);
  let score = RES_SCORE[s.resolution.value];
  ev.push(`${s.resolution.value} (${s.resolution.source}: "${s.resolution.evidence}") → ${score}`);
  if (s.panel) {
    const adj = { OLED: 18, IPS: 10, VA: 3, TN: -15 }[s.panel.value] ?? 0;
    score += adj; ev.push(`${s.panel.value} panel ${adj >= 0 ? '+' : ''}${adj}`);
  } else if (s.resolution.value !== 'Retina') flags.push('panel type unknown');
  if (s.refresh_hz?.value >= 120) { score += 5; ev.push(`${s.refresh_hz.value} Hz +5`); }
  if (s.resolution.value === 'HD') flags.push('low-resolution screen');
  return known(score, ev, flags);
}

// Model-family reputation for keyboard/build (opinionated but fixed and visible).
const FAMILY_BUILD = [
  [/thinkpad\s*(x1|t\d|p\d|x\d)/i, 85, 'ThinkPad T/X/P series'],
  [/thinkpad/i, 72, 'ThinkPad E/L series'],
  [/macbook/i, 82, 'MacBook (aluminium unibody)'],
  [/latitude\s*[79]\d{3}/i, 80, 'Latitude 7000/9000'],
  [/latitude\s*5\d{3}/i, 73, 'Latitude 5000'],
  [/latitude/i, 62, 'Latitude 3000/other'],
  [/xps/i, 80, 'Dell XPS'], [/precision/i, 78, 'Dell Precision'],
  [/elitebook|zbook/i, 78, 'HP EliteBook/ZBook'], [/spectre/i, 78, 'HP Spectre'],
  [/probook/i, 66, 'HP ProBook'], [/envy/i, 68, 'HP Envy'],
  [/surface/i, 78, 'Microsoft Surface'], [/zenbook|expertbook/i, 70, 'Asus ZenBook/ExpertBook'],
  [/thinkbook/i, 68, 'Lenovo ThinkBook'], [/yoga/i, 72, 'Lenovo Yoga'], [/legion/i, 70, 'Lenovo Legion'],
  [/\brog\b/i, 68, 'Asus ROG'], [/swift/i, 62, 'Acer Swift'], [/travelmate/i, 62, 'Acer TravelMate'],
  [/tuf|nitro|victus|omen|predator/i, 60, 'mid-range gaming line'],
  [/ideapad|vivobook|aspire|pavilion|inspiron|vostro|\bhp\s*2[45]0/i, 52, 'consumer/budget line'],
];
export function buildScore(s) {
  const name = s.model?.value.name;
  const fam = name && FAMILY_BUILD.find(([re]) => re.test(name));
  if (!fam) return unknown(name ? `no build reputation data for "${name}"` : 'model not identified');
  let score = fam[1];
  const ev = [`${fam[2]} family baseline ${fam[1]}`], flags = [];
  if (s.backlit) { score += 5; ev.push(`backlit keyboard +5 ("${s.backlit.evidence}")`); }
  if (s.metal) { score += 3; ev.push(`metal chassis mentioned +3`); }
  if (s.damage) { score -= 25; ev.push(`damage mentioned −25 ("${s.damage.evidence}")`); flags.push('damage mentioned'); }
  if (!s.model.value.exact) flags.push('model series only, exact model unknown');
  return known(score, ev, flags);
}

const RAM_BASE = [[64, 100], [32, 92], [24, 82], [16, 75], [12, 55], [8, 40], [4, 10], [0, 0]];
export function ramScore(s) {
  if (!s.ram_gb) return unknown('RAM amount not stated');
  const gb = s.ram_gb.value;
  let score = RAM_BASE.find(([g]) => gb >= g)[1];
  const ev = [`${gb} GB (${s.ram_gb.source}: "${s.ram_gb.evidence}") → ${score}`], flags = [];
  if (s.ram_upgradable) { score += 10; ev.push(`upgradeable +10 ("${s.ram_upgradable.evidence}")`); }
  else if (s.ram_soldered) { score -= 10; ev.push(`soldered −10 (${s.ram_soldered.evidence})`); }
  else flags.push('upgradeability unknown');
  return known(score, ev, flags);
}

export function batteryScore(s) {
  const b = s.battery?.value;
  if (!b) return unknown('battery condition not stated');
  const ev = [`"${s.battery.evidence}" (${s.battery.source})`];
  if (b.hours != null) return known(Math.min(100, b.hours * 11), [...ev, `${b.hours} h × 11`]);
  if (b.health_pct != null) return known(b.health_pct, [...ev, `health ${b.health_pct}%`]);
  if (b.new) return known(85, [...ev, 'new battery → 85']);
  if (b.weak) return known(10, [...ev, 'weak/dead battery → 10'], ['weak battery']);
  return unknown('battery mention unclear');
}

/** Score all listings; value-for-money is relative within the given set (percentile of perf/price). */
export function scoreListings(listings) {
  const rows = listings.map(l => {
    const specs = extractSpecs(l);
    const c = { cpu: cpuScore(specs.cpu), screen: screenScore(specs), build: buildScore(specs), ram: ramScore(specs), battery: batteryScore(specs) };
    return { listing: l, specs, components: c };
  });
  const perf = r => {
    const known = [r.components.cpu, r.components.ram, r.components.screen].filter(x => x.score != null);
    if (r.components.cpu.score == null || r.listing.price_km == null) return null;
    return known.reduce((a, x) => a + x.score, 0) / known.length / r.listing.price_km;
  };
  const ratios = rows.map(perf).filter(x => x != null).sort((a, b) => a - b);
  for (const r of rows) {
    const p = perf(r);
    if (r.listing.price_km == null) r.components.value = unknown('price not stated');
    else if (p == null) r.components.value = unknown('CPU unknown, cannot judge value');
    else {
      const below = ratios.filter(x => x < p).length, equal = ratios.filter(x => x === p).length;
      const pct = ratios.length > 1 ? ((below + (equal - 1) / 2) / (ratios.length - 1)) * 100 : 50;
      r.components.value = known(pct, [`performance per KM is better than ${Math.round(pct)}% of the ${ratios.length} comparable listings`]);
    }
  }
  return rows;
}

export function applyFilters(rows, f = {}) {
  const allow = f.allowUnknown ?? true;
  return rows.filter(({ listing: l, specs: s }) => {
    const price = l.price_km, ram = s.ram_gb?.value, size = s.screen_in?.value, cond = s.condition?.value;
    const check = (val, ok) => (val == null ? allow : ok(val));
    if ((f.priceMin != null || f.priceMax != null) && !check(price, p => (f.priceMin == null || p >= f.priceMin) && (f.priceMax == null || p <= f.priceMax))) return false;
    if (f.ramMin != null && !check(ram, r => r >= f.ramMin)) return false;
    if ((f.screenMin != null || f.screenMax != null) && !check(size, x => (f.screenMin == null || x >= f.screenMin) && (f.screenMax == null || x <= f.screenMax))) return false;
    if (f.conditions?.length && !check(cond, c => f.conditions.includes(c))) return false;
    if (f.excludeBroken !== false && cond === 'broken') return false;
    return true;
  });
}

export function rank(listings, { priorities = DEFAULT_PRIORITIES, filters = {}, top = 50 } = {}) {
  const order = [...priorities.filter(p => COMPONENTS[p]), ...DEFAULT_PRIORITIES.filter(p => !priorities.includes(p))];
  const weights = Object.fromEntries(order.map((k, i) => [k, POSITION_WEIGHTS[i]]));
  const all = scoreListings(listings);
  const rows = applyFilters(all, filters);
  for (const r of rows) {
    let total = 0, knownW = 0;
    const flags = [];
    for (const [k, w] of Object.entries(weights)) {
      const c = r.components[k];
      if (c.score == null) flags.push(`${COMPONENTS[k]} unknown (counted as ${UNKNOWN_SCORE})`);
      else knownW += w;
      total += w * (c.score ?? UNKNOWN_SCORE);
      flags.push(...c.flags);
    }
    for (const [key, label] of [['price_km', 'price'], ['ram_gb', 'RAM'], ['screen_in', 'screen size'], ['condition', 'condition']]) {
      const known = key === 'price_km' ? r.listing.price_km != null : r.specs[key] != null;
      if (!known && filterTouches(filters, key)) flags.push(`${label} unknown — passed filter only because unknowns are allowed`);
    }
    if (r.specs.conflicts?.length) flags.push(...r.specs.conflicts);
    if (!r.listing.detail_fetched_at) flags.push('title only (description not fetched yet)');
    r.total = round(total / 100);
    r.confidence = knownW; // % of priority weight backed by stated data
    r.flags = [...new Set(flags)];
    r.groupKey = groupKey(r.specs, r.listing.id);
  }
  rows.sort((a, b) => b.total - a.total || b.confidence - a.confidence || (a.listing.price_km ?? Infinity) - (b.listing.price_km ?? Infinity) || a.listing.id.localeCompare(b.listing.id));
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.groupKey)) groups.set(r.groupKey, { key: r.groupKey, best: r, offers: [] });
    groups.get(r.groupKey).offers.push(r);
  }
  const ranked = [...groups.values()].slice(0, top).map((g, i) => ({ rank: i + 1, ...g,
    offers: [...g.offers].sort((a, b) => (a.listing.price_km ?? Infinity) - (b.listing.price_km ?? Infinity) || b.total - a.total) }));
  return { weights, considered: all.length, passedFilters: rows.length, groups: groups.size, results: ranked };
}

/** Same exact model + CPU + RAM + storage → same configuration. Anything uncertain stays ungrouped. */
export function groupKey(s, id) {
  if (!s.model?.value.exact || !s.cpu?.value.exact || !s.ram_gb) return `id:${id}`;
  return [s.model.value.name, s.cpu.value.model, `${s.ram_gb.value}GB`, s.storage ? `${s.storage.value.gb}GB` : '?']
    .join(' | ').toLowerCase();
}

function filterTouches(f, key) {
  return (key === 'price_km' && (f.priceMin != null || f.priceMax != null)) || (key === 'ram_gb' && f.ramMin != null)
    || (key === 'screen_in' && (f.screenMin != null || f.screenMax != null)) || (key === 'condition' && f.conditions?.length);
}
function known(score, evidence = [], flags = []) { return { score: round(Math.max(0, Math.min(100, score))), evidence, flags }; }
function unknown(reason, evidence = []) { return { score: null, evidence: [...evidence, reason], flags: [] }; }
function round(x) { return Math.round(x * 10) / 10; }
