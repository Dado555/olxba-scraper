// Polite HTTP fetcher: robots.txt check, fixed pacing with jitter, on-disk cache, stop on blocks.
// There is intentionally no retry-on-block, no proxy rotation and no header spoofing.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectBlock } from './extract.js';

export class BlockedError extends Error {}
export class DisallowedError extends Error {}

export const USER_AGENT = 'olxba-laptop-ranker/2.0 (personal, low-rate; +https://github.com/dado555/olxba-scraper)';

/** Minimal robots.txt evaluator for `User-agent: *` (longest match wins, Allow beats Disallow on tie). */
export function parseRobots(text) {
  const rules = [];
  let applies = false, inAgentBlock = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (key === 'user-agent') {
      if (!inAgentBlock) applies = false;
      inAgentBlock = true;
      if (val === '*' || /olxba-laptop-ranker/i.test(val)) applies = true;
    } else {
      inAgentBlock = false;
      if (applies && (key === 'allow' || key === 'disallow') && val) rules.push({ allow: key === 'allow', path: val });
    }
  }
  return (url) => {
    const u = new URL(url);
    const target = u.pathname + u.search;
    let best = null;
    for (const r of rules) {
      const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(target) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)))
        best = r;
    }
    return !best || best.allow;
  };
}

export class Fetcher {
  constructor({ cacheDir = 'data/cache', delayMs = 6000, jitterMs = 3000, cacheTtlHours = 12,
    transport = defaultTransport, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.log } = {}) {
    Object.assign(this, { cacheDir, delayMs, jitterMs, cacheTtlMs: cacheTtlHours * 3600e3, transport, sleep, log });
    this.lastRequestAt = 0;
    this.robots = null;
    mkdirSync(cacheDir, { recursive: true });
  }

  async checkRobots(url) {
    if (!this.robots) {
      const robotsUrl = new URL('/robots.txt', url).toString();
      const res = await this.#request(robotsUrl);
      if (res.status === 404) this.robots = () => true;
      else if (res.status === 200) this.robots = parseRobots(res.body);
      else throw new BlockedError(`robots.txt returned HTTP ${res.status}; refusing to crawl without it`);
    }
    if (!this.robots(url)) throw new DisallowedError(`robots.txt disallows ${url}`);
  }

  cachePath(url) {
    return join(this.cacheDir, createHash('sha1').update(url).digest('hex') + '.txt');
  }

  /** GET with cache. Returns {status, body, cached}. Throws BlockedError on block/captcha. */
  async get(url, { useCache = true } = {}) {
    const p = this.cachePath(url);
    if (useCache && existsSync(p) && Date.now() - statSync(p).mtimeMs < this.cacheTtlMs)
      return { status: 200, body: readFileSync(p, 'utf8'), cached: true };
    await this.checkRobots(url);
    const res = await this.#request(url);
    const blocked = detectBlock(res.status, res.body);
    if (blocked) throw new BlockedError(`${blocked} at ${url}`);
    if (res.status === 200) writeFileSync(p, res.body);
    return { ...res, cached: false };
  }

  async #request(url) {
    const wait = this.lastRequestAt + this.delayMs + Math.random() * this.jitterMs - Date.now();
    if (this.lastRequestAt && wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
    this.log?.(`GET ${url}`);
    return this.transport(url);
  }
}

async function defaultTransport(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'bs,hr;q=0.8,en;q=0.5' },
      redirect: 'follow', signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`Network error fetching ${url}: ${e.cause?.message || e.message}`);
  }
  return { status: res.status, body: await res.text() };
}
