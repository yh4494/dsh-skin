// test/http-ready.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isHttpReady, waitForHttp, diagnoseListen } = require('../src/http-ready.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) reject(err);
      else resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('http-ready', () => {
  it('isHttpReady true on 200', async () => {
    const fetch = async () => ({ ok: true, status: 200 });
    assert.equal(await isHttpReady('http://127.0.0.1:9', { fetch }), true);
  });

  it('isHttpReady false on connection error', async () => {
    const fetch = async () => {
      throw Object.assign(new Error('fail'), { code: 'ECONNREFUSED' });
    };
    assert.equal(await isHttpReady('http://127.0.0.1:9', { fetch, attempts: 1 }), false);
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

  it('waitForHttp uses probeTimeoutMs not total timeoutMs per probe', async () => {
    let firstAbortMs = null;
    const t0 = Date.now();
    const fetch = (_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          if (firstAbortMs == null) firstAbortMs = Date.now() - t0;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });

    await assert.rejects(
      () =>
        waitForHttp('http://127.0.0.1:9', {
          fetch,
          intervalMs: 5,
          timeoutMs: 130,
          probeTimeoutMs: 40,
        }),
      /ready/,
    );

    assert.ok(firstAbortMs != null);
    // If total timeoutMs (130) were wrongly used as probe timeout, abort ≈130ms.
    assert.ok(
      firstAbortMs >= 15 && firstAbortMs < 100,
      `expected ~40ms probe abort, got ${firstAbortMs}ms`,
    );
  });

  it('default probe true against local http server', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const port = await listen(server);
    try {
      assert.equal(await isHttpReady(`http://127.0.0.1:${port}`), true);
    } finally {
      await close(server);
    }
  });

  it('default probe false when nothing listens', async () => {
    // Prefer an ephemeral closed port: bind then close to learn a free port.
    const binder = http.createServer();
    const port = await listen(binder);
    await close(binder);
    assert.equal(
      await isHttpReady(`http://127.0.0.1:${port}`, { attempts: 1, timeoutMs: 300 }),
      false,
    );
  });
});

describe('diagnoseListen', () => {
  it('returns ready when HTTP probe succeeds', async () => {
    const status = await diagnoseListen('http://127.0.0.1:9', {
      connect: async () => {},
      probeHttp: async () => true,
    });
    assert.equal(status, 'ready');
  });

  it('returns refused when connect fails with ECONNREFUSED', async () => {
    const status = await diagnoseListen('http://127.0.0.1:9', {
      connect: async () => {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
      probeHttp: async () => false,
    });
    assert.equal(status, 'refused');
  });

  it('returns non_http when TCP connects but HTTP fails', async () => {
    const status = await diagnoseListen('http://127.0.0.1:9', {
      connect: async () => {},
      probeHttp: async () => false,
    });
    assert.equal(status, 'non_http');
  });
});
