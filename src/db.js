import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  search_url TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'running',   -- running | complete | blocked | stopped | error
  status_detail TEXT,
  next_page INTEGER NOT NULL DEFAULT 1,
  last_page INTEGER,                         -- as reported by the site, if found
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pages (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  page INTEGER NOT NULL,
  url TEXT NOT NULL,
  http_status INTEGER,
  listings_found INTEGER,
  new_listings INTEGER,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, page)
);
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,                       -- OLX listing ID (dedup key)
  url TEXT NOT NULL,
  title TEXT,
  price_km REAL,
  price_raw TEXT,
  negotiable INTEGER NOT NULL DEFAULT 0,
  condition TEXT,
  tags_json TEXT,
  description TEXT,                          -- only after enrichment
  attributes_json TEXT,                      -- only after enrichment
  detail_fetched_at TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS run_listings (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  page INTEGER,
  PRIMARY KEY (run_id, listing_id)
);`;

export function openDb(path = 'data/olx.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  return db;
}

export function upsertListing(db, l) {
  db.prepare(`INSERT INTO listings (id,url,title,price_km,price_raw,negotiable,condition,tags_json)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, price_km=excluded.price_km, price_raw=excluded.price_raw,
      negotiable=excluded.negotiable, condition=COALESCE(excluded.condition, listings.condition),
      tags_json=excluded.tags_json, last_seen=datetime('now')`)
    .run(l.id, l.url, l.title, l.price_km, l.price_raw, l.negotiable ? 1 : 0, l.condition, JSON.stringify(l.tags ?? []));
}

export function saveDetail(db, id, d) {
  db.prepare(`UPDATE listings SET description=?, attributes_json=?, detail_fetched_at=datetime('now'),
    price_km=COALESCE(?, price_km) WHERE id=?`)
    .run(d.description, JSON.stringify(d.attributes ?? {}), d.price_km ?? null, id);
}

export function runListings(db, runId) {
  const sql = runId
    ? `SELECT l.* FROM listings l JOIN run_listings r ON r.listing_id=l.id WHERE r.run_id=?`
    : `SELECT * FROM listings`;
  return (runId ? db.prepare(sql).all(runId) : db.prepare(sql).all()).map(r => ({
    ...r, negotiable: !!r.negotiable, tags: JSON.parse(r.tags_json || '[]'),
    attributes: r.attributes_json ? JSON.parse(r.attributes_json) : null,
  }));
}
