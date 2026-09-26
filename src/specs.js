// Rule-based spec extraction. Every field is {value, source, evidence} or absent (= unknown).
// Sources are checked in order of reliability: OLX attribute table > title > description.
// Nothing is inferred from model names except facts stated in CPU/model family tables (always labelled).

const FAMILY_BRAND = [
  [/\bthinkpad|thinkbook|ideapad|legion|yoga\b/i, 'Lenovo'],
  [/\bmacbook\b/i, 'Apple'],
  [/\blatitude|xps|inspiron|vostro|precision|alienware\b/i, 'Dell'],
  [/\belitebook|probook|pavilion|envy|omen|zbook|spectre|victus\b/i, 'HP'],
  [/\bvivobook|zenbook|rog|tuf|expertbook\b/i, 'Asus'],
  [/\baspire|swift|nitro|predator|travelmate\b/i, 'Acer'],
  [/\bsurface\b/i, 'Microsoft'],
];
const BRANDS = ['Lenovo', 'Apple', 'Dell', 'HP', 'Asus', 'Acer', 'Microsoft', 'MSI', 'Samsung', 'Toshiba', 'Fujitsu',
  'Huawei', 'Xiaomi', 'Razer', 'Gigabyte', 'Medion', 'LG', 'Sony', 'Chuwi', 'Honor'];
const STOP_TOKEN = /^(i[3579](-?\d.*)?|ryzen|core|intel|amd|celeron|pentium|athlon|m[1-4](pro|max)?|\d+(gb|tb)|gb|tb|\d+[.,]\d+|\d+("|”|''|inch|in|col)|ram|ssd|hdd|nvme|emmc|rtx|gtx|fhd|full|hd|ips|oled|laptop|prodajem|hitno|kao|novo|nov|odličan|odlican|stanje|[-–|,/+]|ne)$/i;

const f = (value, source, evidence) => ({ value, source, evidence: String(evidence).trim().slice(0, 120) });

export function extractSpecs({ title = '', description = '', attributes = null, condition = null, tags = [] }) {
  const attrs = normalizeAttrs(attributes || {});
  const sources = [
    ['title', title || ''],
    ['description', description || ''],
  ];
  const s = { conflicts: [] };

  s.model = parseModel(title) || withSource(parseModel(description), 'description');

  // CPU
  s.cpu = firstOf(sources, parseCpu) || (attrs.cpu ? withSource(parseCpu(attrs.cpu.v), 'attributes') : null);
  if (s.cpu) s.cpu = { ...s.cpu };
  else if (attrs.cpu) s.cpu = f({ raw: attrs.cpu.v, family: attrs.cpu.v, exact: false }, 'attributes', `${attrs.cpu.k}: ${attrs.cpu.v}`);
  // If title only gave family (e.g. "i5") but description has exact model, prefer exact.
  if (s.cpu && !s.cpu.value.exact && description) {
    const d = parseCpu(description);
    if (d?.value.exact) s.cpu = { ...d, source: 'description' };
  }

  // RAM
  const ramAttr = attrs.ram ? num(attrs.ram.v) : null;
  const ramTitle = parseRam(title), ramDesc = parseRam(description);
  if (ramAttr) s.ram_gb = f(ramAttr, 'attributes', `${attrs.ram.k}: ${attrs.ram.v}`);
  else if (ramTitle) s.ram_gb = { ...ramTitle, source: 'title' };
  else if (ramDesc) s.ram_gb = { ...ramDesc, source: 'description' };
  if (ramAttr && ramTitle && ramTitle.value !== ramAttr) s.conflicts.push(`RAM: attributes say ${ramAttr} GB, title says ${ramTitle.value} GB`);

  // Storage
  s.storage = firstOf(sources, parseStorage) || (attrs.storage ? withSource(parseStorage(attrs.storage.v + ' ' + attrs.storage.k), 'attributes') : null);

  // Screen
  const sizeAttr = attrs.screen ? parseScreenSize(attrs.screen.v, true) : null;
  s.screen_in = sizeAttr ? { ...sizeAttr, source: 'attributes' } : firstOf(sources, t => parseScreenSize(t));
  s.resolution = firstOf(sources, parseResolution);
  s.panel = firstOf(sources, parsePanel);
  s.refresh_hz = firstOf(sources, parseRefresh);

  // Condition / warranty
  const condAttr = attrs.condition ? conditionWord(attrs.condition.v) : null;
  if (condAttr) s.condition = f(condAttr, 'attributes', `${attrs.condition.k}: ${attrs.condition.v}`);
  else if (condition) s.condition = f(condition, 'card', tags.join(', ') || condition);
  const broken = firstOf(sources, t => match(t, /\b(neispravan|neispravno|za dijelove|ne pali|ne radi)\b/i, () => true));
  if (broken) s.condition = f('broken', broken.source, broken.evidence);
  s.warranty = firstOf(sources, parseWarranty) || (attrs.warranty ? withSource(parseWarranty(`garancija ${attrs.warranty.v}`), 'attributes') : null);

  // Cues used by component scores
  s.gpu = firstOf(sources, t => match(t, /\b((?:rtx|gtx)\s?\d{3,4}(?:\s?ti)?|mx\s?\d{3}|radeon\s?(?:rx\s?)?\d{3,4}m?)\b/i, m => m[1].toUpperCase()));
  s.backlit = firstOf(sources, t => match(t, /(pozadinsk\w* osvjetljenj\w*|osvijetljen\w* tastatur\w*|osvjetljen\w* tastatur\w*|backlit|keyboard light)/i, () => true));
  s.metal = firstOf(sources, t => match(t, /\b(alumini[ju]\w*|metaln\w*|aluminum|magnezij\w*|magnesium)\b/i, () => true));
  s.damage = firstOf(sources, t => match(t, /(napuk\w*|slomljen\w*|o[sš]te[cć]en\w*|ne radi \w+ tipk\w*|fali tipk\w*|mrtv\w* piksel\w*)/i, m => m[1]));
  s.ram_upgradable = firstOf(sources, t => match(t, /(dva slota|2 slota|2x ?so-?dimm|slobodan slot|mogu[cć]\w* pro[sš]ir\w*|pro[sš]iriv\w*|upgradeable|do \d{2,3} ?gb ram)/i, () => true));
  s.ram_soldered = firstOf(sources, t => match(t, /(zalemljen\w*|lemljen\w*|soldered|onboard ram)/i, () => true));
  if (!s.ram_soldered && s.cpu?.value.vendor === 'Apple')
    s.ram_soldered = f(true, 'rule', 'Apple Silicon MacBooks have soldered RAM');
  s.battery = firstOf(sources, parseBattery);

  for (const k of Object.keys(s)) if (s[k] == null) delete s[k];
  return s;
}

// ---------- individual parsers (return {value, evidence} or null) ----------

export function parseCpu(t) {
  if (!t) return null;
  let m;
  if ((m = t.match(/\b(?:intel\s*)?core\s*ultra\s*([579])\s*[- ]?\s*(\d{3})([a-z]{0,2})\b/i)))
    return ev({ vendor: 'Intel', family: `Core Ultra ${m[1]}`, tier: +m[1], gen: 'ultra' + m[2][0], model: `Core Ultra ${m[1]} ${m[2]}${m[3].toUpperCase()}`, suffix: m[3].toUpperCase(), exact: true }, m[0]);
  if ((m = t.match(/\b(?:intel\s*)?(?:core\s*)?(i[3579])\s*[- ]?\s*(\d{3,5})([a-z]{0,2}\d?)\b/i))) {
    const digits = m[2];
    const gen = digits.length === 5 ? +digits.slice(0, 2) : digits.length === 4 ? (digits[0] === '1' ? +digits.slice(0, 2) : +digits[0]) : 1;
    return ev({ vendor: 'Intel', family: `Core ${m[1].toLowerCase()}`, tier: +m[1][1], gen, model: `${m[1].toLowerCase()}-${digits}${m[3].toUpperCase()}`, suffix: m[3].toUpperCase(), exact: true }, m[0]);
  }
  if ((m = t.match(/\bryzen\s*([3579])\s*(?:pro\s*)?(\d{4})([a-z]{0,2})\b/i)))
    return ev({ vendor: 'AMD', family: `Ryzen ${m[1]}`, tier: +m[1], gen: +m[2][0], sub: +m[2][2], model: `Ryzen ${m[1]} ${m[2]}${m[3].toUpperCase()}`, suffix: m[3].toUpperCase(), exact: true }, m[0]);
  if ((m = t.match(/\b(?:apple\s*)?(m[1-4])\s*(pro|max|ultra)?\b/i)) && /macbook|apple|\bm[1-4]\s*(pro|max)?\s*(chip|čip|cip)?\b.*\b(8|16|24|32)\s?gb/i.test(t))
    return ev({ vendor: 'Apple', family: 'Apple Silicon', gen: +m[1][1], variant: (m[2] || '').toLowerCase(), model: `Apple ${m[1].toUpperCase()}${m[2] ? ' ' + cap(m[2]) : ''}`, exact: true }, m[0]);
  if ((m = t.match(/\b(celeron|pentium(?:\s*silver|\s*gold)?|athlon(?:\s*silver|\s*gold)?)\s*([a-z]?\d{3,4}[a-z]?)?\b/i)))
    return ev({ vendor: /athlon/i.test(m[1]) ? 'AMD' : 'Intel', family: cap(m[1]), model: m[0].trim(), low: true, exact: !!m[2] }, m[0]);
  if ((m = t.match(/\bintel\s*(n\d{3})\b|\b(n100|n200|n305)\b/i)))
    return ev({ vendor: 'Intel', family: 'Intel N', model: (m[1] || m[2]).toUpperCase(), nseries: true, exact: true }, m[0]);
  if ((m = t.match(/\b(?:intel\s*)?core\s*(i[3579])\b|\b(i[3579])\b(?!-?\d)/i)))
    return ev({ vendor: 'Intel', family: `Core ${(m[1] || m[2]).toLowerCase()}`, tier: +(m[1] || m[2])[1], exact: false }, m[0]);
  if ((m = t.match(/\bryzen\s*([3579])\b/i)))
    return ev({ vendor: 'AMD', family: `Ryzen ${m[1]}`, tier: +m[1], exact: false }, m[0]);
  return null;
}

const RAM_SIZES = new Set([2, 4, 6, 8, 12, 16, 20, 24, 32, 36, 40, 48, 64, 96, 128]);
export function parseRam(t) {
  if (!t) return null;
  // explicit "RAM" context first
  let m = t.match(/\b(?:ram|memorij\w*)\s*[:\-]?\s*(\d{1,3})\s*gb\b|\b(\d{1,3})\s*gb\s*(?:ddr\d\w*\s*)?(?:ram|memorij\w*|ddr\d)/i);
  if (m) { const v = +(m[1] || m[2]); if (RAM_SIZES.has(v)) return ev(v, m[0]); }
  // bare "16GB" not followed by storage words and not after "do" (max upgrade)
  const re = /(^|[^\w.])(\d{1,2})\s*gb\b(?!\s*(?:ssd|hdd|nvme|emmc|m\.2|storage|disk|hard|ddr\d?\s*max))/gi;
  for (const x of t.matchAll(re)) {
    const v = +x[2];
    const before = t.slice(Math.max(0, x.index - 6), x.index + x[1].length).toLowerCase();
    if (/\bdo\s*$|\bmax\w*\s*$|\bvram\s*$/.test(before)) continue;
    if (RAM_SIZES.has(v) && v <= 64) return ev(v, x[0]);
  }
  return null;
}

export function parseStorage(t) {
  if (!t) return null;
  const m = t.match(/\b(\d{3,4}|[124])\s*(gb|tb)\s*(ssd|nvme|m\.2|hdd|emmc)?\b(?:\s*(ssd|nvme|hdd|emmc))?/i);
  if (!m) return null;
  const gb = m[2].toLowerCase() === 'tb' ? +m[1] * 1024 : +m[1];
  if (m[2].toLowerCase() === 'gb' && gb < 64) return null;
  const typeRaw = (m[3] || m[4] || '').toLowerCase();
  const type = /ssd|nvme|m\.2/.test(typeRaw) ? 'SSD' : typeRaw === 'hdd' ? 'HDD' : typeRaw === 'emmc' ? 'eMMC' : null;
  return ev({ gb, type }, m[0]);
}

const SIZES = [10.1, 11.6, 12.3, 12.5, 13, 13.3, 13.4, 13.5, 13.6, 14, 14.5, 15, 15.3, 15.6, 16, 16.1, 17, 17.3, 18];
export function parseScreenSize(t, fromAttr = false) {
  if (!t) return null;
  const pats = [/\b(1[0-8](?:[.,]\d)?)\s*(?:"|”|''|inch\w*|in\b|col\w*|″)/i, /(?:ekran\w*|display|zaslon)\s*:?\s*(1[0-8](?:[.,]\d)?)\b/i,
    /\b(1[0-8](?:[.,]\d)?)\s+(?:fhd|full\s*hd|hd|ips|qhd|wqhd|uhd|4k|oled|retina)\b/i,
    /(?<![\d.,x-])(1[0-8][.,][1-6])(?![\d.,]|\s*(?:gb|ghz|mm|kg|h\b|sati))/i];
  if (fromAttr) pats.unshift(/^(1[0-8](?:[.,]\d)?)\b/);
  for (const re of pats) {
    const m = t.match(re);
    if (m) { const v = +m[1].replace(',', '.'); if (SIZES.includes(v)) return ev(v, m[0]); }
  }
  return null;
}

export function parseResolution(t) {
  if (!t) return null;
  const table = [
    [/\b(3840\s*[x×]\s*2160|4k|uhd)\b/i, '4K'],
    [/\b(3\.?[0-9]?k|2880\s*[x×]\s*1800|3000\s*[x×]\s*2000|2880\s*[x×]\s*1620)\b/i, '3K'],
    [/\bretina\b/i, 'Retina'],
    [/\b(2560\s*[x×]\s*1(?:440|600)|qhd\+?|wqhd|wqxga|2k|2\.5k)\b/i, 'QHD'],
    [/\b(1920\s*[x×]\s*1200|wuxga|fhd\+)\b/i, 'WUXGA'],
    [/\b(1920\s*[x×]\s*1080|fhd|full\s*hd|1080p)\b/i, 'FHD'],
    [/\b(1366\s*[x×]\s*768|1600\s*[x×]\s*900|hd ready|hd\+)(?=\W|$)/i, 'HD'],
  ];
  for (const [re, v] of table) { const m = t.match(re); if (m) return ev(v, m[0]); }
  return null;
}
export function parsePanel(t) {
  return match(t, /\b(oled|amoled|ips|tn|va)\b(?:\s*panel)?/i, m => m[1].toUpperCase().replace('AMOLED', 'OLED'));
}
export function parseRefresh(t) {
  return match(t, /\b(60|90|120|144|165|240|300|360)\s*hz\b/i, m => +m[1]);
}
export function parseWarranty(t) {
  if (!t) return null;
  if (/bez\s+garancij\w*/i.test(t)) return ev({ months: 0 }, t.match(/bez\s+garancij\w*/i)[0]);
  let m = t.match(/garancij\w*\s*(?:od\s*|je\s*|:\s*|jo[sš]\s*)?(\d{1,2})\s*(mjesec\w*|mj\b|mes\w*|godin\w*|god\b)/i)
    || t.match(/(\d{1,2})\s*(mjesec\w*|mj\b|godin\w*|god\b)\s*garancij\w*/i);
  if (m) return ev({ months: /god/i.test(m[2]) ? +m[1] * 12 : +m[1] }, m[0]);
  m = t.match(/\bgarancij\w*\b/i);
  return m ? ev({ months: null }, m[0]) : null;
}
export function parseBattery(t) {
  if (!t) return null;
  let m = t.match(/(?:baterij\w*|battery)[^.]{0,40}?(?:drži|drzi|traje|izdr\w*)?\s*(?:oko|do|preko|cca\.?|~)?\s*(\d{1,2}(?:[.,]\d)?)\s*(?:-\s*\d+\s*)?(h\b|sat\w*)/i);
  if (m) return ev({ hours: +m[1].replace(',', '.') }, m[0]);
  m = t.match(/(?:zdravlje|kapacitet|health|wear)\w*\s*(?:baterij\w*|battery)?\s*:?\s*(\d{2,3})\s*%|(?:baterij\w*|battery)\s*(?:zdravlje|health|kapacitet)?\s*:?\s*(\d{2,3})\s*%/i);
  if (m) return ev({ health_pct: +(m[1] || m[2]) }, m[0]);
  m = t.match(/\bnov\w*\s+baterij\w*|baterij\w*\s+(?:je\s+)?nov\w*\b/i);
  if (m) return ev({ new: true }, m[0]);
  m = t.match(/baterij\w*\s+(?:ne drži|ne drzi|slab\w*|mrtv\w*|potrošen\w*|potrosen\w*)|(?:slab\w*|mrtv\w*|potrošen\w*|bez)\s+baterij\w*/i);
  if (m) return ev({ weak: true }, m[0]);
  return null;
}

export function parseModel(t) {
  if (!t) return null;
  const clean = t.replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ');
  let brand = null, start = -1;
  for (const [re, b] of FAMILY_BRAND) {
    const i = clean.search(re);
    if (i >= 0 && (start < 0 || i < start)) { brand = b; start = i; }
  }
  if (!brand) {
    for (const b of BRANDS) {
      const i = clean.search(new RegExp(`\\b${b}\\b`, 'i'));
      if (i >= 0 && (start < 0 || i < start)) { brand = b; start = i + b.length; }
    }
  }
  if (!brand) return null;
  const out = [];
  for (const tok of clean.slice(start).trim().split(' ')) {
    if (!tok || new RegExp(`^${brand}$`, 'i').test(tok)) continue;
    const bare = tok.replace(/[?!.,;:]+$/, '');
    if (!bare || STOP_TOKEN.test(bare) || out.length >= 5) break;
    out.push(bare);
    if (bare !== tok) break;
  }
  // Apple: "MacBook Air M1" -> keep the chip as part of the model name
  if (brand === 'Apple') { const chip = clean.match(/\bm[1-4](\s*(pro|max))?\b/i); if (chip && !out.some(o => /^m[1-4]$/i.test(o))) out.push(chip[0].toUpperCase()); }
  const name = out.join(' ');
  if (!name) return ev({ brand, name: brand, exact: false }, brand, 'title');
  return ev({ brand, name: `${brand} ${name}`, exact: /\b([a-z]+\d+[a-z\d]*|\d{3,}[a-z]*|gen \d+)\b/i.test(name) }, name, 'title');
}

// ---------- helpers ----------
function ev(value, evidence, source = null) { return { value, evidence: String(evidence).trim(), ...(source && { source }) }; }
function withSource(x, source) { return x ? { ...x, source } : null; }
function match(t, re, fn) { const m = t && t.match(re); return m ? ev(fn(m), m[0]) : null; }
function firstOf(sources, fn) {
  for (const [src, text] of sources) { const r = fn(text); if (r) return { ...r, source: src }; }
  return null;
}
function num(s) { const m = String(s).match(/\d+/); return m ? +m[0] : null; }
function cap(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }
function conditionWord(v) { return /kori[sš]ten/i.test(v) ? 'used' : /\bnov/i.test(v) ? 'new' : /neispravan|dijelov/i.test(v) ? 'broken' : null; }

function normalizeAttrs(a) {
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    const key = k.toLowerCase();
    const slot = /^ram|radna memorija/.test(key) ? 'ram' : /procesor|cpu/.test(key) ? 'cpu'
      : /ekran|zaslon|dijagonal/.test(key) ? 'screen' : /stanje/.test(key) ? 'condition'
      : /garancij/.test(key) ? 'warranty' : /ssd|hdd|disk|memorija|pohran|storage/.test(key) ? 'storage' : null;
    if (slot && !out[slot]) out[slot] = { k, v };
  }
  return out;
}
