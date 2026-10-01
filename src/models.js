// Laptop model knowledge: release year from generation-numbering rules, plus optional user-supplied ratings.
//
// The built-in rules only cover product lines with a regular, documented numbering scheme and are labelled "curated"
// (verify before relying on them). No open dataset of laptop build/keyboard/display quality was found, so ratings
// come only from data/laptop-models.json, which the user fills in (e.g. from review sites) with a source per entry:
//   [{ "match": "thinkpad t480", "year": 2018, "build": 82, "display": 60, "source": "https://…review…" }]
import { readFileSync, existsSync } from 'node:fs';

export const LOCAL_MODELS = 'data/laptop-models.json';

const YEAR_RULES = [
  // ThinkPad T440…T490, T450s…T490s, T540p…T590, X240…X280: last-but-one digit = year − 2010
  [/thinkpad\s*t4([4-9])0s?\b/i, m => 2010 + +m[1], 'ThinkPad T4x0: T4N0 → 2010+N'],
  [/thinkpad\s*t5([4-9])0p?\b/i, m => 2010 + +m[1], 'ThinkPad T5x0: T5N0 → 2010+N'],
  [/thinkpad\s*x2([4-8])0\b/i, m => 2010 + +m[1], 'ThinkPad X2x0: X2N0 → 2010+N'],
  [/thinkpad\s*x390\b/i, () => 2019, 'ThinkPad X390 → 2019'],
  [/thinkpad\s*(?:t14s?|t16|x13|p14s|p16s|e14|e15|l14|l15)\s*gen\s*([1-6])\b/i, m => 2019 + +m[1], 'ThinkPad T14/X13/… Gen N → 2019+N'],
  [/thinkpad\s*x1\s*carbon\s*gen\s*([3-9]|1[0-3])\b/i, m => 2012 + +m[1], 'X1 Carbon Gen N (N≥3) → 2012+N'],
  // Dell Latitude 3/5/7 with 4-digit names: last two digits 80, 90, 00, 10 … 50 → 2017 … 2024
  [/latitude\s*[357]\d([89]0|[0-5]0)\b/i, m => ({ '80': 2017, '90': 2018, '00': 2019, '10': 2020, '20': 2021, '30': 2022, '40': 2023, '50': 2024 })[m[1]], 'Latitude [357]x80…x50 → 2017…2024'],
  // HP EliteBook 8x0 / 6x0 Gn: G1 2014 … G11 2024
  [/elitebook\s*[68][3-6]0\s*g([1-9]|1[01])\b/i, m => 2013 + +m[1], 'EliteBook x40 Gn → 2013+n'],
  [/xps\s*13\s*93(60|70|80)\b/i, m => ({ '60': 2016, '70': 2018, '80': 2019 })[m[1]], 'XPS 13 9360/9370/9380'],
  [/xps\s*15\s*95([6-7]0|[0-3]0)\b/i, m => ({ '60': 2017, '70': 2018, '00': 2020, '10': 2021, '20': 2022, '30': 2023 })[m[1]], 'XPS 15 95x0'],
  [/macbook\s*air.*\bm1\b/i, () => 2020, 'MacBook Air M1 → 2020'],
  [/macbook\s*air.*\bm2\b/i, () => 2022, 'MacBook Air M2 → 2022'],
  [/macbook\s*air.*\bm3\b/i, () => 2024, 'MacBook Air M3 → 2024'],
  [/macbook\s*pro.*\bm1\s*(pro|max)\b/i, () => 2021, 'MacBook Pro M1 Pro/Max → 2021'],
  [/macbook\s*pro.*\bm1\b/i, () => 2020, 'MacBook Pro M1 → 2020'],
  [/macbook\s*pro.*\bm2\s*(pro|max)\b/i, () => 2023, 'MacBook Pro M2 Pro/Max → 2023'],
  [/macbook\s*pro.*\bm2\b/i, () => 2022, 'MacBook Pro 13 M2 → 2022'],
  [/macbook\s*pro.*\bm3\b/i, () => 2023, 'MacBook Pro M3 → 2023'],
];

/** Release year implied by a model name, or null. */
export function modelYear(name) {
  if (!name) return null;
  for (const [re, f, rule] of YEAR_RULES) {
    const m = name.match(re);
    if (m) { const y = f(m); if (y) return { year: y, rule }; }
  }
  return null;
}

let cached = null;
export function loadModelOverrides({ path = LOCAL_MODELS, fresh = false } = {}) {
  if (cached && !fresh) return cached;
  try {
    const raw = (path !== LOCAL_MODELS || !process.env.OLX_NO_LOCAL_DATA) && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    cached = (Array.isArray(raw) ? raw : []).filter(e => e && typeof e.match === 'string' && e.match.trim())
      .map(e => ({ ...e, re: new RegExp(e.match.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'i') }));
  } catch (e) {
    console.error(`Could not read ${path}: ${e.message}`);
    cached = [];
  }
  return cached;
}

/** Most specific (longest pattern) user entry matching the model name. */
export function modelOverride(name, overrides = loadModelOverrides()) {
  if (!name) return null;
  return overrides.filter(o => o.re.test(name)).sort((a, b) => b.match.length - a.match.length)[0] ?? null;
}
