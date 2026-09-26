// Extract listing summaries from OLX.ba search pages and details from listing pages.
// Deliberately keyed on `/artikal/<id>` links rather than CSS class names, which change often.
import * as cheerio from 'cheerio';
import { listingIdFromHref, listingUrl } from './url.js';

const EUR_TO_KM = 1.95583; // fixed currency-board peg

/** Parse an OLX.ba price string. Returns {km, raw, negotiable, currency}; km is null when unknown. */
export function parsePrice(raw) {
  const text = (raw ?? '').toString().replace(/\s+/g, ' ').trim();
  const out = { km: null, raw: text || null, negotiable: false, currency: null };
  if (!text) return out;
  if (/po dogovoru|na upit|dogovor/i.test(text)) out.negotiable = true;
  const m = text.match(/(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(KM|BAM|€|EUR)?/i);
  if (!m) return out;
  const whole = Number(m[1].replace(/[.\s]/g, ''));
  const value = m[2] ? whole + Number(`0.${m[2]}`) : whole;
  if (!Number.isFinite(value) || value <= 0) return out; // OLX uses 0 for "na upit"
  const cur = (m[3] || 'KM').toUpperCase();
  out.currency = cur === '€' ? 'EUR' : cur === 'BAM' ? 'KM' : cur;
  out.km = out.currency === 'EUR' ? Math.round(value * EUR_TO_KM) : value;
  return out;
}

const PRICE_RE = /(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,\d{1,2})?\s*(?:KM|BAM|€)|po dogovoru|na upit/i;
const CONDITIONS = [
  [/\bkori[sš]teno\b/i, 'used'],
  [/\bnovo\b/i, 'new'],
  [/\bneispravno|za dijelove\b/i, 'broken'],
];

export function detectBlock(status, body) {
  if ([403, 429, 503].includes(status)) return `HTTP ${status}`;
  const head = String(body ?? '').slice(0, 20000);
  if (/captcha|challenge-form|cf-chl|just a moment\.\.\.|attention required|access denied|unusual traffic/i.test(head))
    return 'captcha/challenge page detected';
  return null;
}

/** Parse a search results page (HTML string or /api/search JSON). */
export function parseSearchPage(body) {
  const trimmed = String(body).trimStart();
  if (trimmed.startsWith('{')) return parseSearchJson(JSON.parse(trimmed));
  return parseSearchHtml(trimmed);
}

function parseSearchJson(json) {
  const items = Array.isArray(json.data) ? json.data : [];
  const listings = items.filter(it => it && it.id != null).map(it => {
    const labels = Object.fromEntries((it.special_labels || []).map(l => [String(l.label), String(l.value)]));
    const price = parsePrice(it.display_price ?? (it.price ? `${it.price} KM` : ''));
    return {
      id: String(it.id), url: listingUrl(it.id), title: String(it.title ?? '').trim(),
      price_km: price.km, price_raw: price.raw, negotiable: price.negotiable,
      condition: conditionFrom(labels.Stanje || ''), tags: Object.entries(labels).map(([k, v]) => `${k}: ${v}`),
    };
  });
  const lastPage = Number(json.meta?.last_page) || null;
  return { listings: dedupe(listings), lastPage, total: Number(json.meta?.total) || null, source: 'api' };
}

function parseSearchHtml(html) {
  const $ = cheerio.load(html);
  const byId = new Map();
  $('a[href*="/artikal/"]').each((_, a) => {
    const id = listingIdFromHref($(a).attr('href'));
    if (!id || byId.has(id)) return;
    // Walk up to the largest ancestor that still only references this one listing = the card.
    let card = $(a);
    for (let p = card.parent(); p.length && !p.is('body'); p = p.parent()) {
      const ids = new Set(p.find('a[href*="/artikal/"]').map((_, x) => listingIdFromHref($(x).attr('href'))).get());
      if (ids.size > 1) break;
      card = p;
    }
    const title = firstText($, card, 'h1, h2, h3, [class*="title"], [class*="heading"]') || $(a).attr('title') || $(a).text();
    const cardText = spacedText($, card);
    const priceMatch = cardText.replace(clean(title), ' ').match(PRICE_RE);
    const price = parsePrice(priceMatch ? priceMatch[0] : '');
    const tags = card.find('.standard-tag div, [class*="tag"] > *').map((_, t) => $(t).text().trim()).get().filter(Boolean);
    byId.set(id, {
      id, url: listingUrl(id), title: clean(title),
      price_km: price.km, price_raw: price.raw, negotiable: price.negotiable,
      condition: conditionFrom(tags.join(' ') || cardText.replace(title, '')), tags,
    });
  });
  let lastPage = null;
  $('a[href*="page="]').each((_, a) => {
    const n = Number(new URL($(a).attr('href'), 'https://olx.ba').searchParams.get('page'));
    if (Number.isInteger(n) && n > (lastPage ?? 0)) lastPage = n;
  });
  return { listings: [...byId.values()], lastPage, total: null, source: 'html' };
}

/** Parse a listing detail page: attribute table + description. */
export function parseDetailPage(html) {
  const $ = cheerio.load(html);
  const attributes = {};
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length >= 2) {
      const k = clean($(cells[0]).text()), v = clean($(cells[1]).text());
      if (k && v && k.length < 60) attributes[k] = v;
    }
  });
  let description = clean($('.ql-editor, [class*="description"]').first().text());
  if (!description) description = clean($('meta[property="og:description"]').attr('content') || '') || null;
  const title = clean($('h1').first().text()) || clean($('meta[property="og:title"]').attr('content') || '');
  const price = parsePrice($('[class*="price"]').first().text());
  return { title: title || null, description: description || null, attributes, price_km: price.km, price_raw: price.raw };
}

export function conditionFrom(text) {
  for (const [re, v] of CONDITIONS) if (re.test(text)) return v;
  return null;
}

function dedupe(listings) {
  const m = new Map();
  for (const l of listings) if (!m.has(l.id)) m.set(l.id, l);
  return [...m.values()];
}
function firstText($, el, sel) {
  const f = el.find(sel).first();
  return f.length ? f.text() : '';
}
/** Text of an element with a space between every text node (cheerio's .text() glues them together). */
function spacedText($, el) {
  const parts = [];
  const walk = n => { for (const c of n.children || []) c.type === 'text' ? parts.push(c.data) : walk(c); };
  el.each((_, n) => walk(n));
  return clean(parts.join(' '));
}
function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}
