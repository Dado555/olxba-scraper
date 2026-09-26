// Deterministic, explainable scoring for development/DevOps use.
//
// Every component returns { score 0-100 | null, basis, evidence[], flags[], min, max }:
//   basis 'verified' – computed only from facts stated in the ad (title / OLX attributes / description)
//   basis 'estimate' – uses a fixed reference table (CPU tier formula, model-family comfort table)
//   basis 'partial'  – some sub-facts stated, the rest unknown (unknown part counted as UNKNOWN_SCORE)
//   basis 'unknown'  – nothing usable; score null, counted as UNKNOWN_SCORE in the total, always flagged
// All curves are fixed functions of the listing's own data. Nothing is normalised against the batch,
// so one ad can never change another ad's score.
import { readFileSync } from 'node:fs';
import { extractSpecs } from './specs.js';

export const COMPONENTS = {
  ram: 'RAM & headroom',
  cpu: 'CPU performance',
  screen: 'Display quality',
  build: 'Keyboard / build / work comfort',
  battery: 'Battery & mobility',
  connectivity: 'Connectivity & longevity',
};
export const DEFAULT_PRIORITIES = ['ram', 'cpu', 'screen', 'build', 'battery', 'connectivity'];
export const POSITION_WEIGHTS = [25, 20, 20, 15, 10, 10]; // sums to 100; weight follows the drag order
export const UNKNOWN_SCORE = 30; // conservative stand-in for unknown facts; always flagged
export const MODES = { quality: 'Best laptop within budget', value: 'Best value' };
export const VALUE_MIX = { quality: 0.8, affordability: 0.2 };
export const AFFORDABILITY_SCALE_KM = 1500; // affordability = 100·exp(−price / scale)

export const DEFAULT_BENCHMARKS = JSON.parse(readFileSync(new URL('./cpu-benchmarks.json', import.meta.url), 'utf8'));

// ---------- curves ----------

/** Piecewise-linear interpolation over fixed points (x ascending). Clamps outside the range. */
export function curve(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i], [x0, y0] = points[i - 1];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points.at(-1)[1];
}
// RAM on a log2 axis → diminishing returns: 8→16 GB matters far more than 32→64 GB.
const RAM_CURVE = [[2, 0], [3, 22], [4, 50], [5, 80], [6, 95], [7, 100]]; // x = log2(GB): 4,8,16,32,64,128
const WEIGHT_CURVE = [[1.0, 100], [1.3, 90], [1.6, 72], [2.0, 50], [2.5, 25], [3.0, 10], [4.5, 0]];
const WARRANTY_CURVE = [[0, 20], [3, 40], [6, 55], [12, 75], [24, 90], [36, 100]];
const saturating = (x, ref) => (100 * x) / (x + ref); // = 50 at x = ref, → 100 asymptotically

export function affordability(priceKm, scale = AFFORDABILITY_SCALE_KM) {
  return priceKm == null ? null : round(100 * Math.exp(-priceKm / scale));
}

// ---------- components ----------

// Coarse relative CPU tiers used ONLY when the exact CPU model is known and not in the benchmark table.
const INTEL_GEN_BASE = { 1: 6, 2: 10, 3: 13, 4: 16, 5: 18, 6: 21, 7: 23, 8: 36, 9: 38, 10: 42, 11: 50, 12: 62, 13: 66, 14: 68, ultra1: 70, ultra2: 74 };
const AMD_GEN_BASE = { 2: 28, 3: 31, 4: 48, 5: 55, 6: 60, 7: 58, 8: 72, 9: 74 };
const TIER_MULT = { 3: 0.75, 5: 1, 7: 1.12, 9: 1.28 };
const APPLE_BASE = { 1: 62, 2: 68, 3: 74, 4: 80 };

export function cpuKey(c) {
  if (!c?.model) return null;
  if (c.vendor === 'Apple') return c.model.toLowerCase();
  if (/^Core Ultra/.test(c.model)) return c.model.replace(/^Core Ultra/, 'ultra').toLowerCase();
  return c.model.toLowerCase();
}

export function cpuScore(cpu, { benchmarks = DEFAULT_BENCHMARKS, conflict = null } = {}) {
  if (conflict) return unknown(`ambiguous CPU: ad mentions ${conflict.value.join(' and ')}`, [], ['CPU ambiguous']);
  if (!cpu) return unknown('CPU not stated');
  const c = cpu.value;
  const src = `(source: ${cpu.source} "${cpu.evidence}")`;
  if (!c.exact) return unknown(`only "${c.family}" stated; exact CPU unknown, performance not inferred ${src}`, [], ['exact CPU unknown']);
  const b = benchmarks?.cpus?.[cpuKey(c)];
  if (b && (b.single != null || b.multi != null)) {
    const ref = benchmarks.reference, parts = [], ev = [];
    if (b.single != null) { const v = saturating(b.single, ref.single); parts.push(v); ev.push(`single-thread ${b.single} ${benchmarks.units.single} → ${round(v)}`); }
    if (b.multi != null) { const v = saturating(b.multi, ref.multi); parts.push(v); ev.push(`multi-thread ${b.multi} ${benchmarks.units.multi} → ${round(v)}`); }
    return result(parts.reduce((a, x) => a + x, 0) / parts.length, 'verified', [`${c.model} ${src}`, ...ev, `benchmark source: ${b.source ?? benchmarks.source ?? 'cpu-benchmarks.json'}`]);
  }
  let base, why;
  if (c.low) { base = 10; why = `${c.model}: low-power Celeron/Pentium/Athlon class`; }
  else if (c.nseries) { base = 24; why = `${c.model}: Intel N-series`; }
  else if (c.vendor === 'Apple') {
    base = APPLE_BASE[c.gen];
    if (base == null) return unknown(`no reference data for ${c.model}`);
    const mult = c.variant === 'max' ? 1.4 : c.variant === 'pro' ? 1.28 : 1;
    base *= mult; why = `${c.model}: Apple Silicon gen ${c.gen}${mult > 1 ? ` ×${mult}` : ''}`;
  } else if (c.vendor === 'Intel') {
    const g = INTEL_GEN_BASE[c.gen];
    if (g == null) return unknown(`unrecognised Intel generation for ${c.model}`);
    const s = c.suffix || '';
    const sm = /^HX/.test(s) ? 1.5 : /^H/.test(s) ? 1.3 : /^P/.test(s) ? 1.12 : /^Y/.test(s) ? 0.7 : /^M/.test(s) && c.gen < 8 ? 1.05 : 1;
    const tm = TIER_MULT[c.tier] ?? 1;
    why = `${c.model}: Intel gen ${c.gen} base ${g} × tier ${tm} × suffix ${s || '-'} ${sm}`;
    base = g * tm * sm;
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
  return result(base, 'estimate', [`${why} ${src}`, 'tier estimate from the exact model number (no benchmark entry)'], ['CPU score is an estimate']);
}

const RES_SCORE = { HD: 20, FHD: 60, WUXGA: 66, QHD: 78, Retina: 82, '3K': 85, '4K': 88 };
/** Only what this ad states about its own screen; the model's other configurations are never assumed. */
export function screenScore(s) {
  if (!s.resolution) return unknown('resolution not stated', s.panel ? [`panel ${s.panel.value} stated`] : []);
  let score = RES_SCORE[s.resolution.value];
  const ev = [`${s.resolution.value} (${s.resolution.source}: "${s.resolution.evidence}") → ${score}`], flags = [];
  if (s.panel) {
    const adj = { OLED: 12, IPS: 10, VA: 3, TN: -15 }[s.panel.value] ?? 0;
    score += adj; ev.push(`${s.panel.value} panel ${adj >= 0 ? '+' : ''}${adj}`);
  } else if (s.resolution.value !== 'Retina') { ev.push('panel type not stated: no panel bonus'); flags.push('panel type unknown'); }
  if (s.refresh_hz?.value >= 120) { score += 5; ev.push(`${s.refresh_hz.value} Hz +5`); }
  if (s.resolution.value === 'HD') flags.push('low-resolution screen');
  return result(score, 'verified', ev, flags);
}

// Model-family keyboard/chassis reputation (fixed, visible, and always labelled an estimate).
const FAMILY_BUILD = [
  [/thinkpad\s*(x1|t\d|p\d|x\d)/i, 80, 'ThinkPad T/X/P series'],
  [/thinkpad/i, 68, 'ThinkPad E/L series'],
  [/macbook/i, 76, 'MacBook'],
  [/latitude\s*[79]\d{3}/i, 76, 'Latitude 7000/9000'],
  [/latitude\s*5\d{3}/i, 70, 'Latitude 5000'],
  [/latitude/i, 60, 'Latitude 3000/other'],
  [/xps/i, 74, 'Dell XPS'], [/precision/i, 74, 'Dell Precision'],
  [/elitebook|zbook/i, 74, 'HP EliteBook/ZBook'], [/spectre/i, 72, 'HP Spectre'],
  [/probook/i, 64, 'HP ProBook'], [/envy/i, 64, 'HP Envy'],
  [/surface/i, 72, 'Microsoft Surface'], [/zenbook|expertbook/i, 66, 'Asus ZenBook/ExpertBook'],
  [/thinkbook/i, 64, 'Lenovo ThinkBook'], [/yoga/i, 66, 'Lenovo Yoga'], [/legion/i, 64, 'Lenovo Legion'],
  [/\brog\b/i, 62, 'Asus ROG'], [/swift/i, 60, 'Acer Swift'], [/travelmate/i, 60, 'Acer TravelMate'],
  [/tuf|nitro|victus|omen|predator/i, 56, 'mid-range gaming line'],
  [/ideapad|vivobook|aspire|pavilion|inspiron|vostro|\bhp\s*2[45]0/i, 50, 'consumer/budget line'],
];
export function buildScore(s) {
  const name = s.model?.value.name;
  const fam = name && FAMILY_BUILD.find(([re]) => re.test(name));
  const stated = [];
  if (s.backlit) stated.push([6, `backlit keyboard +6 ("${s.backlit.evidence}")`]);
  if (s.metal) stated.push([3, `metal chassis +3 ("${s.metal.evidence}")`]);
  if (s.damage) stated.push([-30, `damage mentioned −30 ("${s.damage.evidence}")`]);
  const flags = s.damage ? ['damage mentioned'] : [];
  const adj = stated.reduce((a, [v]) => a + v, 0);
  if (!fam) {
    if (!stated.length) return unknown(name ? `no comfort data for "${name}"` : 'model not identified');
    // Only individual features stated: unknown baseline, features on top.
    return result(UNKNOWN_SCORE + adj, 'partial', [`baseline unknown (${UNKNOWN_SCORE})`, ...stated.map(x => x[1])], flags,
      { min: adj, max: 100 + adj });
  }
  if (!s.model.value.exact) flags.push('model series only, exact model unknown');
  return result(fam[1] + adj, 'estimate', [`${fam[2]} family baseline ${fam[1]} (model-family estimate, not this unit)`, ...stated.map(x => x[1])], flags);
}

export function ramScore(s) {
  if (!s.ram_gb) return unknown('RAM amount not stated');
  const gb = s.ram_gb.value;
  const base = curve(RAM_CURVE, Math.log2(gb));
  let score = base;
  const ev = [`${gb} GB (${s.ram_gb.source}: "${s.ram_gb.evidence}") → ${round(base)}`], flags = [];
  if (s.ram_upgradable) { score += 8; ev.push(`upgrade path stated +8 ("${s.ram_upgradable.evidence}")`); }
  else if (s.ram_soldered) { score -= 8; ev.push(`soldered −8 (${s.ram_soldered.evidence})`); }
  else { ev.push('upgrade path not stated: no bonus'); flags.push('RAM upgradeability unknown'); }
  if (s.storage) {
    const { gb: sg, type } = s.storage.value;
    const sa = sg < 256 ? -10 : sg < 512 ? 0 : sg < 1024 ? 4 : 7;
    const ta = type === 'HDD' || type === 'eMMC' ? -6 : 0;
    score += sa + ta;
    ev.push(`storage ${sg} GB${type ? ' ' + type : ''} ${sa + ta >= 0 ? '+' : ''}${sa + ta}`);
  } else { ev.push('storage size not stated: no adjustment'); flags.push('storage unknown'); }
  return result(score, 'verified', ev, flags);
}

function batterySub(s) {
  const b = s.battery?.value;
  if (!b) return null;
  const e = `"${s.battery.evidence}" (${s.battery.source})`;
  if (b.hours != null) return [Math.min(100, b.hours * 11), `battery ${e}: ${b.hours} h × 11`];
  if (b.health_pct != null) return [b.health_pct, `battery ${e}: health ${b.health_pct}%`];
  if (b.new) return [85, `battery ${e}: new → 85`];
  if (b.weak) return [10, `battery ${e}: weak/dead → 10`];
  return null;
}
export function batteryScore(s) {
  const bat = batterySub(s);
  const w = s.weight_kg ? [curve(WEIGHT_CURVE, s.weight_kg.value), `weight ${s.weight_kg.value} kg ("${s.weight_kg.evidence}") → ${round(curve(WEIGHT_CURVE, s.weight_kg.value))}`] : null;
  const flags = bat?.[0] === 10 ? ['weak battery'] : [];
  return combineSubs([['battery condition', bat], ['weight', w]], flags);
}

export function connectivityScore(s) {
  const PORT_PTS = { 'Thunderbolt/USB4': 35, 'USB-C': 15, HDMI: 10, Ethernet: 10, 'Wi-Fi 6+': 10 };
  const ports = s.ports?.value;
  const p = ports ? [Math.min(100, 20 + ports.reduce((a, x) => a + (PORT_PTS[x] ?? 0), 0)),
    `ports stated: ${ports.join(', ')} (unmentioned ports not assumed)`] : null;
  const wm = s.warranty?.value.months;
  const w = s.warranty ? (wm == null ? [45, `warranty mentioned, length not stated ("${s.warranty.evidence}") → 45`]
    : [curve(WARRANTY_CURVE, wm), `warranty ${wm} months ("${s.warranty.evidence}") → ${round(curve(WARRANTY_CURVE, wm))}`]) : null;
  return combineSubs([['ports', p], ['warranty', w]]);
}

/** Average two equally weighted sub-facts; a missing one is counted as UNKNOWN_SCORE and makes the basis 'partial'. */
function combineSubs(subs, flags = []) {
  const known = subs.filter(([, v]) => v);
  if (!known.length) return unknown(`${subs.map(([n]) => n).join(' and ')} not stated`);
  const missing = subs.filter(([, v]) => !v).map(([n]) => n);
  const sum = known.reduce((a, [, v]) => a + v[0], 0);
  const n = subs.length;
  const ev = [...known.map(([, v]) => v[1]), ...missing.map(m => `${m} not stated (counted as ${UNKNOWN_SCORE})`)];
  return result((sum + missing.length * UNKNOWN_SCORE) / n, missing.length ? 'partial' : 'verified', ev,
    [...flags, ...missing.map(m => `${m} unknown`)], { min: sum / n, max: (sum + missing.length * 100) / n });
}

// ---------- scoring, filters, ranking ----------

export function scoreListings(listings, { benchmarks } = {}) {
  return listings.map(l => {
    const specs = extractSpecs(l);
    const components = {
      ram: ramScore(specs),
      cpu: cpuScore(specs.cpu, { benchmarks, conflict: specs.cpu_conflict }),
      screen: screenScore(specs),
      build: buildScore(specs),
      battery: batteryScore(specs),
      connectivity: connectivityScore(specs),
    };
    return { listing: l, specs, components };
  });
}

const FILTER_FIELDS = {
  price: { label: 'price', value: (l) => l.listing.price_km, active: f => f.priceMin != null || f.priceMax != null,
    ok: (f, p) => (f.priceMin == null || p >= f.priceMin) && (f.priceMax == null || p <= f.priceMax) },
  ram: { label: 'RAM', value: (l) => l.specs.ram_gb?.value, active: f => f.ramMin != null, ok: (f, r) => r >= f.ramMin },
  screen: { label: 'screen size', value: (l) => l.specs.screen_in?.value, active: f => f.screenMin != null || f.screenMax != null,
    ok: (f, x) => (f.screenMin == null || x >= f.screenMin) && (f.screenMax == null || x <= f.screenMax) },
  condition: { label: 'condition', value: (l) => l.specs.condition?.value, active: f => !!f.conditions?.length, ok: (f, c) => f.conditions.includes(c) },
};

/**
 * Hard filters run before any scoring decision. A known value outside a constraint always excludes the listing.
 * An unknown value either excludes it (allowUnknown=false) or lets it through marked "needs verification".
 * `stats` (if given) counts rejections per filter as {unknown, outOfRange}.
 */
export function applyFilters(rows, f = {}, stats = {}) {
  const allow = f.allowUnknown ?? true;
  const reject = (name, unknown) => {
    stats[name] ??= { unknown: 0, outOfRange: 0 };
    stats[name][unknown ? 'unknown' : 'outOfRange']++;
    return false;
  };
  return rows.filter(row => {
    row.needsVerification = [];
    for (const [name, def] of Object.entries(FILTER_FIELDS)) {
      if (!def.active(f)) continue;
      const v = def.value(row);
      if (v == null) {
        if (!allow) return reject(name, true);
        row.needsVerification.push(def.label);
      } else if (!def.ok(f, v)) return reject(name, false);
    }
    if (f.excludeBroken !== false && row.specs.condition?.value === 'broken') return reject('broken', false);
    return true;
  });
}

/** Position weights from a priority order; an explicit `weights` object ({ram: 25, …}) overrides. */
export function resolveWeights(priorities = DEFAULT_PRIORITIES, weights = null) {
  if (weights && Object.keys(COMPONENTS).every(k => Number.isFinite(weights[k]) && weights[k] >= 0)) {
    const sum = Object.keys(COMPONENTS).reduce((a, k) => a + weights[k], 0);
    if (sum > 0) return Object.fromEntries(Object.keys(COMPONENTS).map(k => [k, (weights[k] * 100) / sum]));
  }
  const order = [...priorities.filter(p => COMPONENTS[p]), ...DEFAULT_PRIORITIES.filter(p => !priorities.includes(p))];
  return Object.fromEntries([...new Set(order)].map((k, i) => [k, POSITION_WEIGHTS[i]]));
}

/** Score one already-filtered row. Pure: depends only on this row, the weights and the options. */
export function scoreRow(r, weights, { mode = 'quality', affordabilityScaleKm = AFFORDABILITY_SCALE_KM } = {}) {
  let q = 0, qMin = 0, qMax = 0;
  const certainty = { verified: 0, estimate: 0, partial: 0, unknown: 0 };
  const flags = [];
  for (const [k, w] of Object.entries(weights)) {
    const c = r.components[k];
    certainty[c.basis] += w;
    if (c.score == null) {
      q += w * UNKNOWN_SCORE; qMax += w * 100;
      flags.push(`${COMPONENTS[k]} unknown (counted as ${UNKNOWN_SCORE})`);
    } else { q += w * c.score; qMin += w * c.min; qMax += w * c.max; }
    flags.push(...c.flags);
  }
  r.quality = round(q / 100);
  r.qualityRange = [round(qMin / 100), round(qMax / 100)];
  r.affordability = affordability(r.listing.price_km, affordabilityScaleKm);
  r.mode = mode;
  if (mode === 'value') {
    if (r.affordability == null) flags.push('price unknown: affordability counted as 0');
    r.total = round(VALUE_MIX.quality * r.quality + VALUE_MIX.affordability * (r.affordability ?? 0));
  } else r.total = r.quality;
  for (const k of Object.keys(certainty)) certainty[k] = round(certainty[k]);
  r.certainty = certainty;
  r.confidence = round(certainty.verified); // % of weight backed purely by facts stated in the ad
  for (const v of r.needsVerification ?? []) flags.push(`needs verification: ${v} not stated (hard filter)`);
  if (r.specs.conflicts?.length) flags.push(...r.specs.conflicts);
  if (!r.listing.detail_fetched_at) flags.push('title only (description not fetched yet)');
  r.flags = [...new Set(flags)];
  r.groupKey = groupKey(r.specs, r.listing.id);
  return r;
}

export function compareRows(a, b) {
  return b.total - a.total || b.quality - a.quality || b.confidence - a.confidence
    || (a.listing.price_km ?? Infinity) - (b.listing.price_km ?? Infinity) || String(a.listing.id).localeCompare(String(b.listing.id));
}

/** Mode 'quality' = best laptop within budget (budget is the hard price filter). Mode 'value' = 80% quality + 20% affordability. */
export function rank(listings, { priorities = DEFAULT_PRIORITIES, weights: weightOverride = null, filters = {}, top = 50,
  mode = 'quality', affordabilityScaleKm = AFFORDABILITY_SCALE_KM, benchmarks } = {}) {
  if (!MODES[mode]) mode = 'quality';
  const weights = resolveWeights(priorities, weightOverride);
  const all = scoreListings(listings, { benchmarks });
  const rejected = {};
  const rows = applyFilters(all, filters, rejected).map(r => scoreRow(r, weights, { mode, affordabilityScaleKm }));
  rows.sort(compareRows);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.groupKey)) groups.set(r.groupKey, { key: r.groupKey, best: r, offers: [] });
    groups.get(r.groupKey).offers.push(r);
  }
  const ranked = [...groups.values()].slice(0, top).map((g, i) => ({ rank: i + 1, ...g,
    offers: [...g.offers].sort((a, b) => (a.listing.price_km ?? Infinity) - (b.listing.price_km ?? Infinity) || b.total - a.total) }));
  return { mode, weights, considered: all.length, passedFilters: rows.length, rejected, groups: groups.size, results: ranked };
}

export const rankBestWithinBudget = (listings, opts = {}) => rank(listings, { ...opts, mode: 'quality' });
export const rankBestValue = (listings, opts = {}) => rank(listings, { ...opts, mode: 'value' });

/**
 * Offers are grouped only when the configuration is verified: exact model, one unambiguous exact CPU, RAM and storage
 * all stated. Screen resolution is part of the key (unknown ≠ FHD) so different panels are never merged.
 */
export function groupKey(s, id) {
  if (!s.model?.value.exact || !s.cpu?.value.exact || s.cpu_conflict || !s.ram_gb || !s.storage) return `id:${id}`;
  return [s.model.value.name, s.cpu.value.model, `${s.ram_gb.value}GB`, `${s.storage.value.gb}GB`, s.resolution?.value ?? 'res?']
    .join(' | ').toLowerCase();
}

function result(score, basis, evidence = [], flags = [], range = null) {
  const sc = round(clamp(score));
  return { score: sc, basis, evidence, flags, min: range ? round(clamp(range.min)) : sc, max: range ? round(clamp(range.max)) : sc };
}
function unknown(reason, evidence = [], flags = []) { return { score: null, basis: 'unknown', evidence: [...evidence, reason], flags, min: 0, max: 100 }; }
function clamp(x) { return Math.max(0, Math.min(100, x)); }
function round(x) { return Math.round(x * 10) / 10; }
