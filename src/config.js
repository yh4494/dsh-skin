'use strict';

const DEFAULT_PORT = 18789;

function getPort() {
  const raw = process.env.DSH_SKIN_PORT;
  if (raw == null || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_PORT;
  return n;
}

function getBaseUrl(port = getPort()) {
  return `http://127.0.0.1:${port}`;
}

module.exports = { getPort, getBaseUrl, DEFAULT_PORT };
