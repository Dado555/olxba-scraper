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
   The crawl stops at the first empty page or at the last page the site reports.

   **Pagination cap:** OLX's search endpoint appears to serve only about 50 pages per query (36 ads per page, so
   1800 ads) and then repeats results. When two pages in a row bring no new listing IDs while the site still reports
   more pages, the crawler treats the search as *capped*, not complete. It then re-runs the same search (all your
   filters kept) split into price ranges, splitting any range that still exceeds the cap at the median of the prices
   collected so far. The price parameter names (`price_from`/`price_to`, falling back to `price_min`/`price_max`) are
   checked on every range: returned prices must lie inside it, and the site must report fewer results than the
   unfiltered search. If the site ignores them, or a single price band alone exceeds the cap, the run ends as
   `capped` with the count collected versus the site's total. Ads with no price ("Na upit") can only be reached within
   the first ~50 pages.

   `status=complete` is the only state that means everything reachable was collected. `stopped`, `capped`,
   `blocked` and `error` mean it was not, and the CLI says so. Pressing *Crawl / resume* again continues from where it
   stopped, including runs an older version wrongly marked complete after the first page of repeats.
2. **Filter and prioritise.** Set hard filters (price in KM, minimum RAM, screen size range, condition). Choose whether
   listings with unknown values may pass (they're flagged if they do). Drag the six priorities into order; positions
   are weighted 25 / 20 / 20 / 15 / 10 / 10. The top 100 configurations are shown.
3. **Enrich the shortlist.** *Enrich top 40* fetches detail pages (attribute table + description) only for the listings
   in the current top 40 configuration groups. Descriptions often state the exact CPU, battery condition, RAM slots and
   warranty. Rankings update after enrichment.
4. **Export.** `npm run export` (or the button) writes the top 100 to `data/results.json` and `data/results.csv`.

## Scoring (all visible in the UI's "Evidence" panel)

Ranking targets development and DevOps work. The pipeline runs in this order:

1. **Hard filters come first.** A known price, RAM, screen size or condition outside your constraint removes the listing,
   whatever its quality. If a filtered field is *unknown*, the listing is either removed (box unticked) or kept and
   marked **"Needs verification"** (box ticked). It is never assumed to pass.
2. **Quality score (0–100)** is a weighted sum of six components. The weights follow the drag order:
   **25 / 20 / 20 / 15 / 10 / 10** (default order below). `rank(…, { weights: {ram: …} })` accepts explicit weights too.
3. **Mode** (dropdown, or `npm run rank -- --rank-mode value`):
   - *Best laptop within budget* (`quality`, the default): total = quality. Your budget is the "Price max" hard filter.
   - *Best value* (`value`): total = 0.8 × quality + 0.2 × affordability, with affordability = 100·e^(−price/1500 KM).
     An unknown price counts as affordability 0 and is flagged.

| Component (default weight) | Built from | Curve / rule |
|---|---|---|
| RAM & headroom (25) | Stated RAM; stated upgrade path or soldered RAM; stated storage | log₂ curve 4→16 GB 50, 32 GB 80, 64 GB 95 (diminishing); upgradeable +8, soldered −8, not stated ±0; storage <256 −10, 512 +4, 1 TB +7, HDD/eMMC −6 |
| CPU performance (20) | **Exact** CPU model only | If `src/cpu-benchmarks.json` has the model: single- and multi-thread, each 100·x/(x+reference), averaged (basis *stated*). Otherwise a fixed tier estimate from the exact model number (basis *estimate*). "i7", "Ryzen 7" or a generation alone → **unknown**. Two different CPUs in one ad → **ambiguous/unknown** |
| Display quality (20) | Resolution/panel/refresh stated **in this ad** | HD 20, FHD 60, WUXGA 66, QHD 78, Retina 82, 3K 85, 4K 88; IPS +10, OLED +12, TN −15, panel not stated ±0; ≥120 Hz +5. Never copied from other configurations of the model |
| Keyboard / build / work comfort (15) | Model-family table (always labelled *estimate*) plus stated backlight (+6), metal (+3), damage (−30) | No family and no stated features → unknown |
| Battery & mobility (10) | Stated battery hours/health/new/weak; stated weight | Two equal halves: battery (hours×11, health %, new 85, weak 10) and weight (1.3 kg 90 … 2.5 kg 25). A missing half counts as 30 (*partial*) |
| Connectivity & longevity (10) | Ports stated (Thunderbolt/USB4, USB-C, HDMI, Ethernet, Wi-Fi 6+); warranty | Two halves: ports 20 + points per stated port (unmentioned ports aren't assumed missing *or* present); warranty 0 mo 20 … 12 mo 75 … 36 mo 100 |

**Unknown handling:** an unknown component counts as **30** and is flagged. Each result shows its *possible range*, which is
the quality if every unknown were 0 or 100. It also shows how much of the weight is *stated*, *estimated*, *partial*
or *unknown*. Nothing unstated earns a bonus.

**Independence:** every curve is a fixed function of the ad's own data. There is no min/max or percentile scaling
against the batch, so another ad can't change a laptop's score. A lower price never lowers its Best Value score, and a better
stated spec never lowers its quality. Unit tests check all three.

**CPU benchmarks:** `src/cpu-benchmarks.json` ships **empty** on purpose, because no verified numbers were available. Fill
`cpus` from one consistent source (keys such as `"i5-8350u"`, `"ryzen 7 5800h"`, `"apple m1"`) and set `reference` to the
score that should map to 50. Until then, CPU scores are labelled estimates.

**Grouping:** offers are grouped only when the configuration is verified: the same exact model, one unambiguous exact CPU,
the same RAM, the same storage and the same stated resolution (unknown resolution never merges with a known one).
Model-family matches alone never group.

**Tie-breaks:** total, then quality, then % verified, then price, then listing ID.

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
