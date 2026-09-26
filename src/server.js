// Local-only web server (binds 127.0.0.1). Crawls run in the background, one at a time.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { rankRun, serialize, enrichShortlist, latestRun, exportResults } from './app.js';
import { crawl } from './crawl.js';
import { COMPONENTS, DEFAULT_PRIORITIES, POSITION_WEIGHTS, MODES } from './score.js';

export function startServer(db, makeFetcher, { port = 5173, host = '127.0.0.1' } = {}) {
  const html = new URL('../public/index.html', import.meta.url);
  const job = { running: false, kind: null, log: [] };
  const log = m => { job.log.push(`${new Date().toLocaleTimeString()} ${m}`); if (job.log.length > 300) job.log.shift(); console.log(m); };
  const startJob = (kind, fn) => {
    if (job.running) throw Object.assign(new Error(`a ${job.kind} job is already running`), { status: 409 });
    Object.assign(job, { running: true, kind });
    fn().catch(e => log(`ERROR: ${e.message}`)).finally(() => { job.running = false; });
  };

  const routes = {
    'GET /': (_, res) => send(res, 200, readFileSync(html), 'text/html; charset=utf-8'),
    'GET /api/state': () => ({ run: latestRun(db), runs: db.prepare('SELECT * FROM runs ORDER BY id DESC').all(),
      job: { running: job.running, kind: job.kind, log: job.log.slice(-60) }, components: COMPONENTS, defaultPriorities: DEFAULT_PRIORITIES, positionWeights: POSITION_WEIGHTS, modes: MODES }),
    'POST /api/rank': b => serialize(rankRun(db, b)),
    'POST /api/crawl': b => { startJob('crawl', () => crawl(db, makeFetcher(log), b.url, { maxPages: b.maxPages || Infinity, restart: !!b.restart, log })
      .then(s => log(`Crawl ${s.status}: ${s.unique_listings} unique listings, ${s.pages_fetched} pages. ${s.status_detail ?? ''}`))); return { started: true }; },
    'POST /api/enrich': b => { startJob('enrich', () => enrichShortlist(db, makeFetcher(log), { ...b, log })
      .then(r => log(`Enrichment: ${r.done}/${r.total} detail pages fetched${r.stopped ? ' — stopped: ' + r.stopped : ''}`))); return { started: true }; },
    'POST /api/export': b => exportResults(db, b),
  };

  const server = createServer(async (req, res) => {
    const key = `${req.method} ${new URL(req.url, 'http://x').pathname}`;
    const handler = routes[key];
    if (!handler) return send(res, 404, JSON.stringify({ error: 'not found' }));
    try {
      let body = {};
      if (req.method === 'POST') { let raw = ''; for await (const c of req) raw += c; body = raw ? JSON.parse(raw) : {}; }
      const out = await handler(body, res);
      if (out !== undefined) send(res, 200, JSON.stringify(out));
    } catch (e) {
      send(res, e.status || 400, JSON.stringify({ error: e.message }));
    }
  });
  return new Promise(r => server.listen(port, host, () => r(server)));
}

function send(res, status, body, type = 'application/json') {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
