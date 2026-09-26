// Resumable crawl of every page of one OLX.ba search URL. Progress lives in SQLite (runs/pages tables).
import { normalizeSearchUrl, pageUrl, apiSearchUrl } from './url.js';
import { parseSearchPage } from './extract.js';
import { upsertListing } from './db.js';
import { BlockedError, DisallowedError } from './fetcher.js';

export async function crawl(db, fetcher, inputUrl, { maxPages = Infinity, hardCap = 300, restart = false,
  mode = 'auto', log = console.log } = {}) {
  const searchUrl = normalizeSearchUrl(inputUrl);
  let run = db.prepare('SELECT * FROM runs WHERE search_url=?').get(searchUrl);
  if (!run || restart) {
    if (run) db.prepare(`UPDATE runs SET status='running', next_page=1, last_page=NULL, status_detail=NULL WHERE id=?`).run(run.id);
    else db.prepare('INSERT INTO runs (search_url) VALUES (?)').run(searchUrl);
    run = db.prepare('SELECT * FROM runs WHERE search_url=?').get(searchUrl);
  } else if (run.status === 'complete') {
    log(`Run ${run.id} already complete (${run.pages_fetched} pages). Use --restart to recrawl.`);
    return summary(db, run.id);
  } else {
    log(`Resuming run ${run.id} at page ${run.next_page} (previous status: ${run.status}).`);
  }
  const setRun = (fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE runs SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`)
      .run(...keys.map(k => fields[k]), run.id);
  };
  setRun({ status: 'running', status_detail: null });

  let useApi = mode === 'api';
  let lastPage = run.last_page;
  let fetchedThisSession = 0;
  for (let page = run.next_page; ; page++) {
    if (fetchedThisSession >= maxPages) {
      setRun({ status: 'stopped', status_detail: `stopped after --max-pages ${maxPages}; resume to continue`, next_page: page });
      break;
    }
    if (page > hardCap) { setRun({ status: 'stopped', status_detail: `hit safety cap of ${hardCap} pages`, next_page: page }); break; }
    let parsed, url, status;
    try {
      url = useApi ? apiSearchUrl(searchUrl, page) : pageUrl(searchUrl, page);
      ({ body: parsed, status } = await fetcher.get(url));
      parsed = parseSearchPage(parsed);
      if (!useApi && mode === 'auto' && page === 1 && parsed.listings.length === 0) {
        log('HTML page 1 had no listing links (page may be client-rendered); trying the JSON search endpoint with the same filters.');
        useApi = true;
        url = apiSearchUrl(searchUrl, page);
        const r = await fetcher.get(url);
        status = r.status;
        parsed = parseSearchPage(r.body);
      }
    } catch (e) {
      const kind = e instanceof BlockedError ? 'blocked' : e instanceof DisallowedError ? 'stopped' : 'error';
      setRun({ status: kind, status_detail: e.message, next_page: page });
      log(`STOPPED (${kind}) at page ${page}: ${e.message}`);
      break;
    }
    fetchedThisSession++;
    if (parsed.lastPage) lastPage = Math.max(lastPage ?? 0, parsed.lastPage);
    let fresh = 0;
    db.exec('BEGIN');
    for (const l of parsed.listings) {
      const seen = db.prepare('SELECT 1 FROM run_listings WHERE run_id=? AND listing_id=?').get(run.id, l.id);
      upsertListing(db, l);
      if (!seen) { fresh++; db.prepare('INSERT INTO run_listings (run_id, listing_id, page) VALUES (?,?,?)').run(run.id, l.id, page); }
    }
    db.prepare(`INSERT OR REPLACE INTO pages (run_id,page,url,http_status,listings_found,new_listings) VALUES (?,?,?,?,?,?)`)
      .run(run.id, page, url, status, parsed.listings.length, fresh);
    db.exec('COMMIT');
    setRun({ next_page: page + 1, last_page: lastPage, pages_fetched: run.pages_fetched + fetchedThisSession });
    log(`page ${page}${lastPage ? '/' + lastPage : ''}: ${parsed.listings.length} listings, ${fresh} new`);

    const done = parsed.listings.length === 0 ? 'empty page reached'
      : fresh === 0 ? 'page contained no new listing IDs'
      : lastPage && page >= lastPage ? `reached last page (${lastPage})` : null;
    if (done) { setRun({ status: 'complete', status_detail: done }); break; }
  }
  return summary(db, run.id);
}

export function summary(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  const n = db.prepare('SELECT COUNT(*) n FROM run_listings WHERE run_id=?').get(runId).n;
  return { ...run, unique_listings: n };
}
