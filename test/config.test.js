const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { getPort, getBaseUrl } = require('../src/config.js');

describe('config', () => {
  const prev = process.env.DSH_SKIN_PORT;
  afterEach(() => {
    if (prev === undefined) delete process.env.DSH_SKIN_PORT;
    else process.env.DSH_SKIN_PORT = prev;
  });

  it('defaults to 18789', () => {
    delete process.env.DSH_SKIN_PORT;
    assert.equal(getPort(), 18789);
  });

  it('reads DSH_SKIN_PORT', () => {
    process.env.DSH_SKIN_PORT = '19000';
    assert.equal(getPort(), 19000);
  });

  it('falls back on invalid port', () => {
    process.env.DSH_SKIN_PORT = 'nope';
    assert.equal(getPort(), 18789);
  });

  it('builds base url', () => {
    assert.equal(getBaseUrl(18789), 'http://127.0.0.1:18789');
  });
});
