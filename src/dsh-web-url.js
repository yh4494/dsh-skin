'use strict';

/**
 * Extract the authenticated root URL from dsh web stdout.
 * Line shape: `dsh web: http://127.0.0.1:port/?token=...` with optional ` (LAN: ...)`.
 */
function parseDshWebAuthenticatedUrl(text) {
  const m = String(text).match(/(?:^|\n)dsh web:\s+(https?:\/\/\S+)/);
  if (!m) return null;
  let href;
  try {
    const url = new URL(m[1]);
    if (!url.searchParams.get('token')) return null;
    href = url.href;
  } catch {
    return null;
  }
  return href;
}

module.exports = { parseDshWebAuthenticatedUrl };
