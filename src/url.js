// URL helpers: keep every user filter intact, only ever change the page number.

const OLX_HOSTS = new Set(['olx.ba', 'www.olx.ba']);

export function normalizeSearchUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new Error(`Not a valid URL: ${input}`);
  }
  if (!OLX_HOSTS.has(u.hostname)) throw new Error(`Not an OLX.ba URL: ${u.hostname}`);
  if (u.protocol !== 'https:') u.protocol = 'https:';
  u.hash = '';
  u.searchParams.delete('page'); // page is controlled by the crawler
  return u.toString();
}

/** Build page N of a search, preserving all other query params (incl. repeated ones and their order). */
export function pageUrl(searchUrl, page) {
  const u = new URL(searchUrl);
  u.searchParams.delete('page');
  if (page > 1) u.searchParams.append('page', String(page));
  return u.toString();
}

/** Same filters against the JSON endpoint the OLX.ba front-end uses (/api/search). Unverified from cloud; used only as fallback. */
export function apiSearchUrl(searchUrl, page) {
  const u = new URL(pageUrl(searchUrl, page));
  u.pathname = '/api/search';
  if (page <= 1) u.searchParams.set('page', '1');
  return u.toString();
}

/** OLX.ba listing URLs look like https://olx.ba/artikal/12345678 (optionally with a slug). */
export function listingIdFromHref(href) {
  if (!href) return null;
  const m = String(href).match(/\/artikal\/(\d{4,})/);
  return m ? m[1] : null;
}

export function listingUrl(id) {
  return `https://olx.ba/artikal/${id}`;
}
