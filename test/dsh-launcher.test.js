const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLauncher } = require('../src/dsh-launcher.js');
const { DshErrorCode } = require('../src/errors.js');

function fakeChild(opts = {}) {
  const ee = new EventEmitter();
  ee.killed = false;
  ee.exitCode = null;
  ee.pid = opts.pid ?? 1001;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.stdout.setEncoding = () => {};
  ee.stderr.setEncoding = () => {};
  ee.kill = (sig) => {
    ee.killed = true;
    ee.exitCode = 0;
    queueMicrotask(() => ee.emit('exit', 0, sig));
    return true;
  };
  return ee;
}

function emitAuthUrl(child, url = 'http://127.0.0.1:18789/?token=test-token') {
  queueMicrotask(() => {
    child.stdout.emit('data', `dsh web: ${url}\n`);
  });
}

describe('dsh-launcher', () => {
  it('reclaims existing dsh then spawns owned process', async () => {
    let ready = true;
    let reclaimed = false;
    let spawnCount = 0;
    const child = fakeChild();
    const launcher = createLauncher({
      isHttpReady: async () => {
        if (reclaimed) return false;
        return ready;
      },
      diagnoseListen: async () => 'refused',
      waitForHttp: async () => {},
      urlGraceMs: 20,
      resolveDshPath: () => '/bin/dsh',
      reclaimDshPort: async () => {
        reclaimed = true;
        ready = false;
        return { killed: [1] };
      },
      spawn: () => {
        spawnCount += 1;
        emitAuthUrl(child, 'http://127.0.0.1:18789/?token=after-reclaim');
        return child;
      },
    });
    const r = await launcher.start({ port: 18789, baseUrl: 'http://127.0.0.1:18789' });
    assert.equal(r.reused, false);
    assert.equal(r.appUrl, 'http://127.0.0.1:18789/?token=after-reclaim');
    assert.equal(spawnCount, 1);
    assert.equal(launcher.owned, true);
    assert.equal(reclaimed, true);
  });

  it('stops prior owned child before starting again', async () => {
    const first = fakeChild({ pid: 11 });
    const second = fakeChild({ pid: 22 });
    let spawnCount = 0;
    const launcher = createLauncher({
      isHttpReady: async () => false,
      diagnoseListen: async () => 'refused',
      waitForHttp: async () => {},
      urlGraceMs: 20,
      resolveDshPath: () => '/bin/dsh',
      reclaimDshPort: async () => ({ killed: [] }),
      spawn: () => {
        spawnCount += 1;
        const child = spawnCount === 1 ? first : second;
        emitAuthUrl(child, `http://127.0.0.1:1/?token=t${spawnCount}`);
        return child;
      },
    });

    await launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' });
    assert.equal(launcher.child, first);

    const r = await launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' });
    assert.equal(first.killed, true);
    assert.equal(r.appUrl, 'http://127.0.0.1:1/?token=t2');
    assert.equal(launcher.child, second);
    assert.equal(spawnCount, 2);
  });

  it('spawns when not ready and returns authenticated URL', async () => {
    const child = fakeChild();
    const launcher = createLauncher({
      isHttpReady: async () => false,
      diagnoseListen: async () => 'refused',
      waitForHttp: async () => {},
      urlGraceMs: 20,
      resolveDshPath: () => '/bin/dsh',
      reclaimDshPort: async () => ({ killed: [] }),
      spawn: (cmd, args) => {
        assert.equal(cmd, '/bin/dsh');
        assert.deepEqual(args, ['web', '--no-open', '--port', '18789']);
        emitAuthUrl(child, 'http://127.0.0.1:18789/?token=spawn-token');
        return child;
      },
    });
    const r = await launcher.start({ port: 18789, baseUrl: 'http://127.0.0.1:18789' });
    assert.equal(r.reused, false);
    assert.equal(r.appUrl, 'http://127.0.0.1:18789/?token=spawn-token');
    assert.equal(launcher.owned, true);
  });

  it('falls back to baseUrl when auth URL never prints', async () => {
    const child = fakeChild();
    const launcher = createLauncher({
      isHttpReady: async () => false,
      diagnoseListen: async () => 'refused',
      waitForHttp: async () => {},
      urlGraceMs: 10,
      resolveDshPath: () => '/bin/dsh',
      reclaimDshPort: async () => ({ killed: [] }),
      spawn: () => child,
    });
    const r = await launcher.start({ port: 18789, baseUrl: 'http://127.0.0.1:18789' });
    assert.equal(r.reused, false);
    assert.equal(r.appUrl, 'http://127.0.0.1:18789');
  });

  it('surfaces spawn error without leaving owned orphan', async () => {
    const child = fakeChild();
    const launcher = createLauncher({
      isHttpReady: async () => false,
      diagnoseListen: async () => 'refused',
      waitForHttp: () => new Promise(() => {}),
      resolveDshPath: () => '/missing/dsh',
      reclaimDshPort: async () => ({ killed: [] }),
      spawn: () => {
        queueMicrotask(() => {
          child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        });
        return child;
      },
    });

    await assert.rejects(
      () => launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' }),
      /Failed to spawn dsh: \/missing\/dsh not found \(ENOENT\)/,
    );
    assert.equal(launcher.owned, false);
    assert.equal(launcher.child, null);
  });

  it('stop kills owned child', async () => {
    const child = fakeChild();
    const launcher = createLauncher({
      isHttpReady: async () => false,
      diagnoseListen: async () => 'refused',
      waitForHttp: async () => {},
      urlGraceMs: 10,
      resolveDshPath: () => '/bin/dsh',
      reclaimDshPort: async () => ({ killed: [] }),
      spawn: () => {
        emitAuthUrl(child);
        return child;
      },
    });
    await launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' });
    await launcher.stop();
    assert.equal(child.killed, true);
    assert.equal(launcher.owned, false);
  });

  it('throws PORT_BUSY_NON_HTTP when diagnose says non_http', async () => {
    const launcher = createLauncher({
      isHttpReady: async () => false,
      diagnoseListen: async () => 'non_http',
      resolveDshPath: () => '/bin/dsh',
      reclaimDshPort: async () => ({ killed: [] }),
      spawn: () => {
        throw new Error('should not spawn');
      },
    });
    await assert.rejects(
      () => launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' }),
      (err) => err.code === DshErrorCode.PORT_BUSY_NON_HTTP,
    );
  });

  it('throws PORT_BUSY_NON_HTTP when reclaim finds non-dsh', async () => {
    const launcher = createLauncher({
      isHttpReady: async () => true,
      resolveDshPath: () => '/bin/dsh',
      reclaimDshPort: async () => {
        const err = new Error('port held by nginx');
        err.code = 'port_busy_non_dsh';
        throw err;
      },
      spawn: () => {
        throw new Error('should not spawn');
      },
    });
    await assert.rejects(
      () => launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' }),
      (err) => err.code === DshErrorCode.PORT_BUSY_NON_HTTP,
    );
  });

  it('throws NOT_FOUND with code when bin missing', async () => {
    const launcher = createLauncher({
      isHttpReady: async () => false,
      diagnoseListen: async () => 'refused',
      resolveDshPath: () => null,
      reclaimDshPort: async () => ({ killed: [] }),
      spawn: () => fakeChild(),
    });
    await assert.rejects(
      () => launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' }),
      (err) => err.code === DshErrorCode.NOT_FOUND,
    );
  });

  it('stop uses killTree with SIGTERM then SIGKILL', async () => {
    const child = fakeChild({ pid: 4242 });
    child.kill = () => true; // do not auto-exit
    const signals = [];
    const launcher = createLauncher({
      isHttpReady: async () => false,
      diagnoseListen: async () => 'refused',
      waitForHttp: async () => {},
      urlGraceMs: 10,
      resolveDshPath: () => '/bin/dsh',
      reclaimDshPort: async () => ({ killed: [] }),
      spawn: () => {
        emitAuthUrl(child);
        return child;
      },
      killGraceMs: 20,
      killTree: (pid, sig) => {
        signals.push([pid, sig]);
        if (sig === 'SIGKILL') {
          child.exitCode = 0;
          queueMicrotask(() => child.emit('exit', 0, sig));
        }
      },
    });
    await launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' });
    await launcher.stop();
    assert.deepEqual(signals[0], [4242, 'SIGTERM']);
    assert.equal(signals.at(-1)[1], 'SIGKILL');
  });
});
