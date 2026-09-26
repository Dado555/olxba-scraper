#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { Fetcher } from '../src/fetcher.js';
import { crawl } from '../src/crawl.js';
import { enrichShortlist, exportResults, loadDemo, rankRun } from '../src/app.js';
import { startServer } from '../src/server.js';

const HELP = `Usage: node bin/cli.js <command> [options]
  crawl <olx search url>   collect all pages (resumes automatically)
      --max-pages N          stop after N pages this session (smoke test: 2)
      --restart              start this search from page 1 again
      --mode auto|html|api   page source (default auto)
  enrich                   fetch detail pages for the top --top N groups (default 40)
  rank                     print the top results in the terminal
  export                   write data/results.json and .csv (--out path/prefix)
  serve                    start the local UI at http://127.0.0.1:5173 (--port)
  demo                     load bundled synthetic fixtures into data/demo.sqlite and serve
Common: --db path (default data/olx.sqlite)  --delay seconds between requests (default 6, min 3)
        --price-max N --ram-min N --top N`;

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  'max-pages': { type: 'string' }, restart: { type: 'boolean' }, mode: { type: 'string', default: 'auto' },
  db: { type: 'string', default: 'data/olx.sqlite' }, delay: { type: 'string', default: '6' }, port: { type: 'string', default: '5173' },
  top: { type: 'string' }, out: { type: 'string', default: 'data/results' }, 'price-max': { type: 'string' }, 'ram-min': { type: 'string' },
  help: { type: 'boolean', short: 'h' } } });
const [cmd, arg] = positionals;
const delayMs = Math.max(3, Number(o.delay)) * 1000;
const makeFetcher = (log = console.log) => new Fetcher({ delayMs, jitterMs: delayMs / 2, log });
const filters = { priceMax: o['price-max'] ? +o['price-max'] : undefined, ramMin: o['ram-min'] ? +o['ram-min'] : undefined };

if (!cmd || o.help) { console.log(HELP); process.exit(0); }
if (cmd === 'demo') o.db = 'data/demo.sqlite';
const db = openDb(o.db);

switch (cmd) {
  case 'crawl': {
    if (!arg) { console.error('crawl needs an OLX.ba search URL (quote it in the shell)'); process.exit(2); }
    const s = await crawl(db, makeFetcher(), arg, { maxPages: o['max-pages'] ? +o['max-pages'] : Infinity, restart: o.restart, mode: o.mode });
    console.log(`\nRun ${s.id}: status=${s.status}${s.status_detail ? ` (${s.status_detail})` : ''}`);
    console.log(`Pages fetched: ${s.pages_fetched}${s.last_page ? ` of ${s.last_page} reported by site` : ''}; unique listings: ${s.unique_listings}`);
    if (s.status !== 'complete') console.log('NOT all results collected. Re-run the same command to resume.');
    process.exitCode = ['blocked', 'error'].includes(s.status) ? 1 : 0;
    break;
  }
  case 'enrich': console.log(await enrichShortlist(db, makeFetcher(), { n: +(o.top ?? 40), filters })); break;
  case 'rank': {
    const r = rankRun(db, { filters, top: +(o.top ?? 20) });
    console.log(`${r.considered} listings, ${r.passedFilters} after filters, ${r.groups} configurations. Weights: ${JSON.stringify(r.weights)}`);
    for (const [k, v] of Object.entries(r.rejected)) console.log(`  removed by ${k} filter: ${v.outOfRange} out of range, ${v.unknown} unknown value`);
    for (const g of r.results) {
      const b = g.best;
      console.log(`#${g.rank} ${b.total} (conf ${b.confidence}%) ${b.listing.price_km ?? '?'} KM  ${b.listing.title}${g.offers.length > 1 ? `  [${g.offers.length} offers]` : ''}\n     ${b.listing.url}  ` +
        Object.entries(b.components).map(([k, c]) => `${k}:${c.score ?? '?'}`).join(' '));
    }
    break;
  }
  case 'export': console.log(exportResults(db, { out: o.out, filters, top: +(o.top ?? 50) })); break;
  case 'demo':
    loadDemo(db, fileURLToPath(new URL('../test/fixtures', import.meta.url)));
    console.log('Loaded SYNTHETIC fixture data (not live OLX data).');
  // fallthrough
  case 'serve': {
    await startServer(db, makeFetcher, { port: +o.port });
    console.log(`UI running at http://127.0.0.1:${o.port}  (Ctrl+C to stop)`);
    break;
  }
  default: console.log(HELP); process.exit(2);
}
