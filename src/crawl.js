// Resumable crawl of every page of one OLX.ba search URL. Progress lives in SQLite (runs/pages/slices tables).
//
// Phase 1 pages through the search as given. Some endpoints stop paginating (e.g. OLX's /api/search appears to serve
// only the first ~50 pages and then repeats results). That is detected as two consecutive pages with no new
// listing IDs while the site still reports more pages. It is NOT treated as "complete".
//
// Phase 2 (only after such a cap): the same search, all filters kept, is split into price ranges. Each range must
// fit under the cap; ranges that don't are split again at the median of prices already collected. The price
// parameter is verified on every range (returned prices must lie inside it). If the site ignores it, the crawl
// stops with status 'capped' and says so; it never claims completeness it can't verify.
import { normalizeSearchUrl, pageUrl, apiSearchUrl } from './url.js';
import { parseSearchPage } from './extract.js';
import { upsertListing } from './db.js';
import { BlockedError, DisallowedError } from './fetcher.js';

// Candidate query parameter names for a price range. Unverified guesses; each is checked against returned prices.
export const PRICE_PARAM_CANDIDATES = [['price_from', 'price_to'], ['price_min', 'price_max']];
const MAX_PRICE = 1_000_000;

export async function crawl(db, fetcher, inputUrl, { maxPages = Infinity, hardCap = 300, restart = false,
  mode = 'auto', maxSliceDepth = 24, log = console.log } = {}) {
  const searchUrl = normalizeSearchUrl(inputUrl);
  let run = db.prepare('SELECT * FROM runs WHERE search_url=?').get(searchUrl);
  if (!run || restart) {
    if (run) {
      db.prepare('DELETE FROM slice_pages WHERE slice_id IN (SELECT id FROM slices WHERE run_id=?)').run(run.id);
      db.prepare('DELETE FROM slices WHERE run_id=?').run(run.id);
      db.prepare(`UPDATE runs SET status='running', next_page=1, last_page=NULL, status_detail=NULL, cap_page=NULL,
        price_params=NULL, site_total=NULL WHERE id=?`).run(run.id);
    } else db.prepare('INSERT INTO runs (search_url) VALUES (?)').run(searchUrl);
    run = db.prepare('SELECT * FROM runs WHERE search_url=?').get(searchUrl);
  } else if (run.status === 'complete' && !(run.last_page && run.next_page <= run.last_page && !run.cap_page)) {
    log(`Run ${run.id} already complete (${run.pages_fetched} pages). Use --restart to recrawl.`);
    return summary(db, run.id);
  } else if (run.status === 'complete') {
    // Runs finished by an older version that stopped at the first page of repeats.
    log(`Run ${run.id} was marked complete at page ${run.next_page - 1}, but the site reports ${run.last_page} pages. Continuing.`);
  } else {
    log(`Resuming run ${run.id} (previous status: ${run.status}).`);
  }

  const ctx = {
    db, fetcher, log, hardCap, maxSliceDepth, searchUrl, runId: run.id,
    budget: maxPages, fetched: 0,
    useApi: mode === 'api' || (mode === 'auto' && /\/api\/search/.test(lastUrl(db, run.id) ?? '')),
    mode,
  };
  ctx.setRun = fields => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE runs SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`)
      .run(...keys.map(k => fields[k]), run.id);
  };
  ctx.run = () => db.prepare('SELECT * FROM runs WHERE id=?').get(run.id);
  ctx.setRun({ status: 'running', status_detail: null });

  try {
    if (!ctx.run().cap_page) {
      const r = await crawlBase(ctx);
      if (r.outcome !== 'capped') { finish(ctx, r); return summary(db, run.id); }
    }
    finish(ctx, await crawlSlices(ctx));
  } catch (e) {
    const kind = e instanceof BlockedError ? 'blocked' : e instanceof DisallowedError ? 'stopped' : 'error';
    ctx.setRun({ status: kind, status_detail: `${e.message} (progress saved; run again to resume)` });
    log(`STOPPED (${kind}): ${e.message}`);
  }
  return summary(db, run.id);
}

function finish(ctx, r) {
  ctx.setRun({ status: r.outcome === 'stopped' ? 'stopped' : r.outcome, status_detail: r.detail });
}

// ---------- phase 1: the search as given ----------

async function crawlBase(ctx) {
  const { db, runId } = ctx;
  let run = ctx.run();
  let lastPage = run.last_page;
  let zeros = trailingZeroPages(db, runId);
  for (let page = run.next_page; ; page++) {
    if (ctx.fetched >= ctx.budget) return { outcome: 'stopped', detail: `stopped after --max-pages ${ctx.budget}; run again to resume` };
    if (page > ctx.hardCap) return { outcome: 'stopped', detail: `hit safety cap of ${ctx.hardCap} pages` };
    const { parsed, url, status } = await fetchSearch(ctx, page, true);
    if (parsed.lastPage) lastPage = Math.max(lastPage ?? 0, parsed.lastPage);
    const fresh = record(ctx, parsed.listings, page);
    db.prepare(`INSERT OR REPLACE INTO pages (run_id,page,url,http_status,listings_found,new_listings) VALUES (?,?,?,?,?,?)`)
      .run(runId, page, url, status, parsed.listings.length, fresh);
    ctx.setRun({ next_page: page + 1, last_page: lastPage, pages_fetched: ctx.run().pages_fetched + 1,
      ...(parsed.total ? { site_total: parsed.total } : {}) });
    ctx.log(`page ${page}${lastPage ? '/' + lastPage : ''}: ${parsed.listings.length} listings, ${fresh} new`);

    if (parsed.listings.length === 0) return { outcome: 'complete', detail: 'empty page reached' };
    if (lastPage && page >= lastPage) return { outcome: 'complete', detail: `reached last page (${lastPage})` };
    if (fresh > 0) { zeros = 0; continue; }
    zeros++;
    if (!lastPage) return { outcome: 'complete', detail: 'page contained no new listing IDs (site reports no page count)' };
    if (zeros >= 2) {
      const capPage = page - zeros;
      ctx.setRun({ cap_page: capPage });
      ctx.log(`Pages ${capPage + 1}–${page} only repeat earlier listings although the site reports ${lastPage} pages: ` +
        `the site appears to serve at most ${capPage} pages per search. Splitting the same search into price ranges.`);
      return { outcome: 'capped' };
    }
  }
}

// ---------- phase 2: price-range slices ----------

async function crawlSlices(ctx) {
  const { db, runId, log } = ctx;
  const capPage = ctx.run().cap_page;
  if (!db.prepare('SELECT 1 FROM slices WHERE run_id=?').get(runId)) {
    const u = new URL(ctx.searchUrl);
    const lo = num(u.searchParams.get('price_from') ?? u.searchParams.get('price_min')) ?? 0;
    const hi = num(u.searchParams.get('price_to') ?? u.searchParams.get('price_max')) ?? MAX_PRICE;
    db.prepare('INSERT INTO slices (run_id, lo, hi) VALUES (?,?,?)').run(runId, lo, hi);
  }
  for (;;) {
    const slice = db.prepare(`SELECT * FROM slices WHERE run_id=? AND status IN ('pending','crawling') ORDER BY id LIMIT 1`).get(runId);
    if (!slice) return sliceSummary(ctx);
    const setSlice = f => db.prepare(`UPDATE slices SET ${Object.keys(f).map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(f), slice.id);
    const label = `price ${slice.lo}–${slice.hi === MAX_PRICE ? '∞' : slice.hi} KM`;

    if (slice.status === 'pending') {
      if (ctx.fetched >= ctx.budget) return { outcome: 'stopped', detail: `stopped after --max-pages ${ctx.budget}; run again to resume` };
      const probe = await probeSlice(ctx, slice);
      if (!probe) {
        setSlice({ status: 'unsupported', detail: 'site ignored the price-range parameters' });
        db.prepare(`UPDATE slices SET status='unsupported' WHERE run_id=? AND status IN ('pending','crawling')`).run(runId);
        return sliceSummary(ctx);
      }
      const { parsed } = probe;
      const fresh = recordSlicePage(ctx, slice.id, 1, probe);
      const lp = parsed.lastPage ?? null;
      log(`[${label}] page 1${lp ? '/' + lp : ''}: ${parsed.listings.length} listings, ${fresh} new`);
      if (lp && lp > capPage) {
        const mid = splitPoint(db, runId, slice.lo, slice.hi);
        if (mid != null && slice.depth < ctx.maxSliceDepth) {
          setSlice({ status: 'split', last_page: lp, detail: `${lp} pages > cap ${capPage}; split at ${mid} KM` });
          db.prepare('INSERT INTO slices (run_id, lo, hi, depth) VALUES (?,?,?,?), (?,?,?,?)')
            .run(runId, slice.lo, mid, slice.depth + 1, runId, mid, slice.hi, slice.depth + 1);
          log(`[${label}] ${lp} pages is over the ${capPage}-page cap; splitting at ${mid} KM.`);
          continue;
        }
      }
      if (parsed.listings.length === 0 || !lp || lp <= 1) { setSlice({ status: 'done', next_page: 2, last_page: lp }); continue; }
      setSlice({ status: 'crawling', next_page: 2, last_page: lp });
      continue;
    }

    // status 'crawling': fetch the remaining pages of this range
    const seen = new Set();
    for (let page = slice.next_page; ; page++) {
      if (ctx.fetched >= ctx.budget) return { outcome: 'stopped', detail: `stopped after --max-pages ${ctx.budget}; run again to resume` };
      const end = Math.min(slice.last_page, capPage);
      if (page > end) {
        setSlice(slice.last_page > capPage
          ? { status: 'capped', detail: `range too narrow to split; only ${capPage} of ${slice.last_page} pages reachable` }
          : { status: 'done' });
        break;
      }
      const res = await fetchSlicePage(ctx, slice, page);
      const fresh = recordSlicePage(ctx, slice.id, page, res);
      setSlice({ next_page: page + 1 });
      log(`[${label}] page ${page}/${slice.last_page}: ${res.parsed.listings.length} listings, ${fresh} new`);
      const ids = res.parsed.listings.map(l => l.id);
      const localNew = ids.filter(id => !seen.has(id)).length;
      ids.forEach(id => seen.add(id));
      if (res.parsed.listings.length === 0) { setSlice({ status: 'done' }); break; }
      if (localNew === 0 && page > slice.next_page) { // range itself started repeating
        setSlice({ status: 'capped', detail: `range repeated results at page ${page}` });
        break;
      }
    }
  }
}

/** Fetch page 1 of a range, choosing (once) and re-checking the price parameter names. Returns null if ignored. */
async function probeSlice(ctx, slice) {
  const run = ctx.run();
  const candidates = run.price_params ? [run.price_params.split(',')] : PRICE_PARAM_CANDIDATES;
  for (const pair of candidates) {
    const res = await fetchSlicePage(ctx, slice, 1, pair);
    const verdict = respectsRange(ctx, res.parsed, slice, pair);
    if (verdict.ok) {
      // Only a range that excludes some known listings can prove the parameters work.
      if (!run.price_params && verdict.conclusive) {
        ctx.setRun({ price_params: pair.join(',') });
        ctx.log(`Price range parameters ${pair.join('/')} verified: ${verdict.why}.`);
      }
      return res;
    }
    ctx.log(`Price parameters ${pair.join('/')} not honoured by the site (${verdict.why}).`);
    if (run.price_params) return null;
  }
  return null;
}

function respectsRange(ctx, parsed, slice, pair) {
  const priced = parsed.listings.filter(l => l.price_km != null);
  const outside = priced.filter(l => l.price_km < slice.lo * 0.98 - 1 || l.price_km > slice.hi * 1.02 + 1);
  if (priced.length && outside.length / priced.length > 0.1)
    return { ok: false, conclusive: true, why: `${outside.length}/${priced.length} returned prices outside ${slice.lo}–${slice.hi} KM` };
  // If the range excludes listings we already hold, the site must report fewer results than the unfiltered search.
  const run = ctx.run();
  const excludes = ctx.db.prepare(`SELECT 1 FROM run_listings r JOIN listings l ON l.id=r.listing_id
    WHERE r.run_id=? AND (l.price_km < ? OR l.price_km > ?) LIMIT 1`).get(ctx.runId, slice.lo, slice.hi);
  const notSmaller = (parsed.total != null && run.site_total != null && parsed.total >= run.site_total)
    || (parsed.total == null && parsed.lastPage != null && run.last_page != null && parsed.lastPage >= run.last_page);
  if (excludes && notSmaller)
    return { ok: false, conclusive: true, why: `range excludes known listings but the site still reports ${parsed.total ?? parsed.lastPage + ' pages'}` };
  if (!priced.length) return { ok: !excludes || parsed.listings.length === 0, conclusive: false, why: 'no priced listings returned to check against' };
  return { ok: true, conclusive: !!excludes, why: `all ${priced.length - outside.length}/${priced.length} priced results inside ${slice.lo}–${slice.hi} KM` };
}

function sliceSummary(ctx) {
  const rows = ctx.db.prepare('SELECT status, COUNT(*) n FROM slices WHERE run_id=? GROUP BY status').all(ctx.runId);
  const c = Object.fromEntries(rows.map(r => [r.status, r.n]));
  const run = ctx.run();
  const n = ctx.db.prepare('SELECT COUNT(*) n FROM run_listings WHERE run_id=?').get(ctx.runId).n;
  const of = run.site_total ? ` of ${run.site_total} the site reports` : '';
  if (c.unsupported) return { outcome: 'capped', detail: `site serves only ${run.cap_page} pages per search and ignored the price-range parameters (${PRICE_PARAM_CANDIDATES.map(p => p.join('/')).join(', ')}); collected ${n}${of}. Narrow the search on OLX (e.g. price bands) and crawl each URL.` };
  if (c.capped) return { outcome: 'capped', detail: `${c.capped} price range(s) still exceeded the ${run.cap_page}-page cap; collected ${n}${of}` };
  return { outcome: 'complete', detail: `all ${c.done ?? 0} price ranges crawled (search capped at ${run.cap_page} pages); ${n} unique listings${of}` };
}

// ---------- helpers ----------

async function fetchSearch(ctx, page, allowFallback) {
  let url = ctx.useApi ? apiSearchUrl(ctx.searchUrl, page) : pageUrl(ctx.searchUrl, page);
  let res = await ctx.fetcher.get(url);
  ctx.fetched++;
  let parsed = parseSearchPage(res.body);
  if (allowFallback && !ctx.useApi && ctx.mode === 'auto' && page === 1 && parsed.listings.length === 0) {
    ctx.log('HTML page 1 had no listing links (page may be client-rendered); trying the JSON search endpoint with the same filters.');
    ctx.useApi = true;
    url = apiSearchUrl(ctx.searchUrl, page);
    res = await ctx.fetcher.get(url);
    ctx.fetched++;
    parsed = parseSearchPage(res.body);
  }
  return { parsed, url, status: res.status };
}

async function fetchSlicePage(ctx, slice, page, pair = ctx.run().price_params?.split(',') ?? PRICE_PARAM_CANDIDATES[0]) {
  const u = new URL(ctx.searchUrl);
  for (const p of PRICE_PARAM_CANDIDATES.flat()) if (pair.includes(p)) u.searchParams.delete(p);
  u.searchParams.set(pair[0], String(slice.lo));
  if (slice.hi < MAX_PRICE) u.searchParams.set(pair[1], String(slice.hi));
  const base = u.toString();
  const url = ctx.useApi ? apiSearchUrl(base, page) : pageUrl(base, page);
  const res = await ctx.fetcher.get(url);
  ctx.fetched++;
  return { parsed: parseSearchPage(res.body), url, status: res.status };
}

function recordSlicePage(ctx, sliceId, page, { parsed, url, status }) {
  const fresh = record(ctx, parsed.listings, null);
  ctx.db.prepare(`INSERT OR REPLACE INTO slice_pages (slice_id,page,url,http_status,listings_found,new_listings) VALUES (?,?,?,?,?,?)`)
    .run(sliceId, page, url, status, parsed.listings.length, fresh);
  ctx.setRun({ pages_fetched: ctx.run().pages_fetched + 1 });
  return fresh;
}

/** Upsert listings, attach new ones to the run; returns how many IDs were new to this run. */
function record(ctx, listings, page) {
  const { db, runId } = ctx;
  let fresh = 0;
  db.exec('BEGIN');
  try {
    for (const l of listings) {
      const seen = db.prepare('SELECT 1 FROM run_listings WHERE run_id=? AND listing_id=?').get(runId, l.id);
      upsertListing(db, l);
      if (!seen) { fresh++; db.prepare('INSERT INTO run_listings (run_id, listing_id, page) VALUES (?,?,?)').run(runId, l.id, page); }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return fresh;
}

/** Median of collected prices strictly inside (lo, hi), rounded; midpoint if too few; null if the range can't split. */
function splitPoint(db, runId, lo, hi) {
  if (hi - lo < 2) return null;
  const prices = db.prepare(`SELECT l.price_km p FROM run_listings r JOIN listings l ON l.id=r.listing_id
    WHERE r.run_id=? AND l.price_km > ? AND l.price_km < ? ORDER BY l.price_km`).all(runId, lo, hi).map(r => r.p);
  let mid = prices.length >= 10 ? Math.round(prices[Math.floor(prices.length / 2)]) : Math.round((lo + Math.min(hi, lo + 20000)) / 2);
  if (mid <= lo || mid >= hi) mid = Math.round((lo + hi) / 2);
  return mid > lo && mid < hi ? mid : null;
}

function trailingZeroPages(db, runId) {
  let n = 0;
  for (const r of db.prepare('SELECT new_listings FROM pages WHERE run_id=? ORDER BY page DESC').all(runId)) {
    if (r.new_listings !== 0) break;
    n++;
  }
  return n;
}
function lastUrl(db, runId) { return db.prepare('SELECT url FROM pages WHERE run_id=? ORDER BY page DESC LIMIT 1').get(runId)?.url; }
function num(v) { const n = v == null || v === '' ? null : Number(v); return Number.isFinite(n) ? n : null; }

export function summary(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  const n = db.prepare('SELECT COUNT(*) n FROM run_listings WHERE run_id=?').get(runId).n;
  return { ...run, unique_listings: n };
}
