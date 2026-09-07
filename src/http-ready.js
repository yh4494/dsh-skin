// src/http-ready.js
'use strict';

// Default readiness uses Node http/https (not undici fetch): in Electron main,
// fetch to 127.0.0.1 can false-negative on first probe and cause a duplicate
// `dsh web` spawn during port reuse. Inject opts.fetch only in unit tests.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { URL } = require('node:url');

function probeWithHttp(baseUrl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      done(false);
      return;
    }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        done(true);
      },
    );
    req.on('error', () => done(false));
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
  });
}

async function probeWithFetch(baseUrl, fetchFn, timeoutMs) {
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

async function isHttpReady(baseUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1500;
  // Electron main can flake on the first localhost probe; retry briefly.
  const attempts = opts.attempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 50;

  for (let i = 0; i < attempts; i++) {
    const ok = opts.fetch
      ? await probeWithFetch(baseUrl, opts.fetch, timeoutMs)
      : await probeWithHttp(baseUrl, timeoutMs);
    if (ok) return true;
    if (i + 1 < attempts) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return false;
}

async function waitForHttp(baseUrl, opts = {}) {
  const intervalMs = opts.intervalMs ?? 250;
  // Total wait budget — must not be forwarded as per-probe timeout.
  const timeoutMs = opts.timeoutMs ?? 60000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 1500;
  const start = Date.now();
  // Loop already retries; keep each probe to a single attempt with short timeout.
  const probeOpts = {
    fetch: opts.fetch,
    timeoutMs: probeTimeoutMs,
    attempts: opts.attempts ?? 1,
    retryDelayMs: opts.retryDelayMs,
  };
  while (Date.now() - start < timeoutMs) {
    if (await isHttpReady(baseUrl, probeOpts)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('dsh did not become ready in time');
}

function defaultConnect(hostname, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostname, port }, () => {
      socket.destroy();
      resolve();
    });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    socket.on('error', reject);
  });
}

async function diagnoseListen(baseUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1500;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'unknown';
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const hostname = url.hostname;
  const connect = opts.connect
    ? (h, p) => opts.connect(h, p)
    : (h, p) => defaultConnect(h, p, timeoutMs);
  const probeHttp =
    opts.probeHttp ?? ((u) => isHttpReady(u, { timeoutMs, attempts: 1 }));

  if (await probeHttp(baseUrl)) return 'ready';

  try {
    await connect(hostname, port);
    return 'non_http';
  } catch (err) {
    if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT')) {
      return 'refused';
    }
    return 'unknown';
  }
}

module.exports = { isHttpReady, waitForHttp, diagnoseListen };
