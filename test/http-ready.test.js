// test/http-ready.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isHttpReady, waitForHttp } = require('../src/http-ready.js');

describe('http-ready', () => {
  it('isHttpReady true on 200', async () => {
    const fetch = async () => ({ ok: true, status: 200 });
    assert.equal(await isHttpReady('http://127.0.0.1:9', { fetch }), true);
  });

  it('isHttpReady false on connection error', async () => {
    const fetch = async () => {
      throw Object.assign(new Error('fail'), { code: 'ECONNREFUSED' });
    };
    assert.equal(await isHttpReady('http://127.0.0.1:9', { fetch }), false);
  });

  it('waitForHttp resolves when ready', async () => {
    let n = 0;
    const fetch = async () => {
      n += 1;
      if (n < 2) throw Object.assign(new Error('no'), { code: 'ECONNREFUSED' });
      return { ok: true, status: 200 };
    };
    await waitForHttp('http://127.0.0.1:9', { fetch, intervalMs: 10, timeoutMs: 500 });
  });

  it('waitForHttp throws on timeout', async () => {
    const fetch = async () => {
      throw Object.assign(new Error('no'), { code: 'ECONNREFUSED' });
    };
    await assert.rejects(
      () => waitForHttp('http://127.0.0.1:9', { fetch, intervalMs: 10, timeoutMs: 50 }),
      /ready/,
    );
  });
});
