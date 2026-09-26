# OLX.ba Laptop Ranker

A local app for finding laptops on OLX.ba and ranking them. Paste a filtered OLX.ba laptop search URL. The app collects every
reachable results page (keeping all your filters), deduplicates by listing ID, saves progress in SQLite and can resume.
It extracts specs with fixed rules and ranks laptops by *your* priority order. Every score shows its evidence and
uncertainty flags.

- No LLM grading. Extraction and scoring are regular expressions plus small fixed tables, so the same input always gives the same ranking.
- Unknown stays unknown. A spec that isn't stated in the title, the OLX attribute table or the description is shown as `?`.
  It is never guessed. Unknown components count as 30/100 in the total and are flagged, and a confidence % shows how much
  of the weighting rests on stated data.
- It crawls politely. It checks robots.txt first, sends one request at a time 6–9 s apart (configurable, minimum 3 s),
  caches pages for 12 h, and identifies itself with an honest User-Agent. It stops on HTTP 403/429/503 or on any
  captcha or challenge page, and marks the run `blocked` so you can resume later. There are no bypasses: no stealth
  browser, no proxy rotation, no retries against blocks.

## Quick start

Requires Node.js 22.5 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
npm start                      # UI at http://127.0.0.1:5173
```

Try the UI without network access by loading the bundled **synthetic** fixtures:

```bash
npm run demo                   # separate DB: data/demo.sqlite
```

## Workflow

1. **Collect.** Paste your OLX.ba search URL (for example with category, price and RAM filters already set on OLX)
   and click *Crawl / resume*. Or use the CLI:
   ```bash
   npm run smoke -- "https://olx.ba/pretraga?category_id=39&..."   # 2-page smoke test
   npm run crawl -- "https://olx.ba/pretraga?category_id=39&..."   # all pages; re-run to resume
   ```
   The crawl stops at the first empty page, at a page with no new listing IDs, or at the last page the pagination
   reports. `status=complete` is the only state that means everything reachable was collected. `stopped`, `blocked`
   and `error` mean it was not, and the CLI says so.
2. **Filter and prioritise.** Set hard filters (price in KM, minimum RAM, screen size range, condition). Choose whether
   listings with unknown values may pass (they're flagged if they do). Drag the six priorities into order; positions
   are weighted 30 / 24 / 18 / 13 / 9 / 6.
3. **Enrich the shortlist.** *Enrich top 40* fetches detail pages (attribute table + description) only for the listings
   in the current top 40 configuration groups. Descriptions often state the exact CPU, battery condition, RAM slots and
   warranty. Rankings update after enrichment.
4. **Export.** `npm run export` (or the button) writes `data/results.json` and `data/results.csv`.

## Scoring (all visible in the UI's "Evidence" panel)

| Component | Based on | Unknown when |
|---|---|---|
| CPU performance | Exact CPU model → fixed generation × tier (i3/i5/i7/i9, Ryzen 3–9) × suffix (U/H/HX/P) table. These are coarse relative tiers, **not benchmarks** | Only "i5" etc. is known, or no CPU is mentioned |
| Screen quality | Resolution (HD…4K/Retina) + panel (IPS/OLED/TN) + ≥120 Hz | Resolution not stated |
| Keyboard / build | Fixed model-family table (e.g. ThinkPad T/X 85, EliteBook 78, IdeaPad 52), plus backlit keyboard/metal, minus stated damage | Model family not identified |
| RAM / upgradeability | GB amount, +10 if slots/upgrade mentioned, −10 if soldered (always true for Apple Silicon) | RAM not stated |
| Battery | Stated hours, health %, "nova baterija", or "baterija slaba" | Nothing stated (common before enrichment) |
| Value for money | Percentile of (mean of known CPU/RAM/screen scores) ÷ price, compared within the filtered set | Price or CPU unknown |

**Grouping:** listings with the same exact model, CPU model, RAM and storage are grouped as one configuration. The group
shows every offer, cheapest first. If any of those fields is uncertain, the listing is never grouped.

**Tie-breaks:** total score, then confidence, then price, then listing ID.

## Project layout

```
bin/cli.js          crawl | enrich | rank | export | serve | demo
src/url.js          filter-preserving pagination, listing IDs
src/fetcher.js      robots.txt, pacing, cache, block/captcha detection
src/extract.js      search page (HTML or /api/search JSON) + detail page parsing, price parsing
src/specs.js        rule-based spec extraction with source + evidence per field
src/score.js        component scores, filters, weighted ranking, grouping
src/crawl.js        resumable crawl state machine (SQLite: runs/pages/listings/run_listings)
src/app.js          enrichment shortlist, export, demo loader
public/index.html   the UI (no build step)
test/               node:test suites + fixtures
examples/           example export produced from the synthetic fixtures
```

## Tests

```bash
npm test
```

These cover pagination with filter preservation, extraction (HTML and JSON), price parsing (`1.150 KM`, `1 899,50 KM`,
`Po dogovoru`, €), dedup across pages, resume after `--max-pages`, stopping on captcha and 429, robots rules, unknown
values, CPU/RAM/storage/screen disambiguation, scoring, priority reordering, filters, grouping, shortlist-only
enrichment and export.

> **The fixtures in `test/fixtures/` are hand-built** to match OLX.ba's markup. They were not captured live, because the
> development environment could not reach olx.ba. The extractor deliberately keys on `/artikal/<id>` links and on
> text patterns rather than CSS class names, but it still needs checking against the real site (below).

## Verifying against live OLX.ba (run locally)

```bash
npm install
npm test                                                  # fixture tests
npm run smoke -- "https://olx.ba/pretraga?category_id=39"  # replace with your filtered URL
npm run rank -- --top 10
```

To make the real pages permanent test fixtures:

```bash
mkdir -p test/fixtures/live
# cached raw pages are in data/cache/*.txt; copy the two search pages:
for f in $(ls -t data/cache/*.txt | head -2); do cp "$f" "test/fixtures/live/search-$(basename "$f" .txt).html"; done
npm test          # the 'live captured search pages' test now runs instead of being skipped
```

If the smoke crawl reports `0 listings`, OLX may have switched to client-side rendering. The crawler then automatically
retries page 1 against the JSON endpoint the site itself uses (`/api/search`, same filters). You can force either source with
`--mode html` or `--mode api`. If both give 0, save the page (`curl -A x "<url>" > test/fixtures/live/search-1.html`)
and adjust `parseSearchHtml` in `src/extract.js`.

## Terms and robots

The crawler reads `https://olx.ba/robots.txt` before its first request and refuses URLs it disallows. If robots.txt
can't be fetched (anything other than 200 or 404), it refuses to crawl. Before collecting large amounts of data, check
OLX.ba's terms of use (Uslovi korištenja) yourself. This tool is for personal, low-volume use.
