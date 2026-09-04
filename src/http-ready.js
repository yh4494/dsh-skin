// src/http-ready.js
'use strict';

async function isHttpReady(baseUrl, opts = {}) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchFn(baseUrl, { signal: ctrl.signal, redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function waitForHttp(baseUrl, opts = {}) {
  const intervalMs = opts.intervalMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHttpReady(baseUrl, opts)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('dsh did not become ready in time');
}

module.exports = { isHttpReady, waitForHttp };
