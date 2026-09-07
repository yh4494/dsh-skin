const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLauncher } = require('../src/dsh-launcher.js');
const { DshErrorCode } = require('../src/errors.js');

function fakeChild() {
  const ee = new EventEmitter();
  ee.killed = false;
  ee.exitCode = null;
  ee.kill = (sig) => {
    ee.killed = true;
    ee.exitCode = 0;
    queueMicrotask(() => ee.emit('exit', 0, sig));
    return true;
  };
  return ee;
}

describe('dsh-launcher', () => {
  it('reuses existing server without spawn', async () => {
    let spawned = false;
    const launcher = createLauncher({
      isHttpReady: async () => true,
      waitForHttp: async () => {},
      resolveDshPath: () => '/bin/dsh',
      spawn: () => {
        spawned = true;
        return fakeChild();
      },
    });
    const r = await launcher.start({ port: 18789, baseUrl: 'http://127.0.0.1:18789' });
    assert.equal(r.reused, true);
    assert.equal(spawned, false);
    assert.equal(launcher.owned, false);
  });

  it('owned + already ready stays owned (no orphan)', async () => {
    const child = fakeChild();
    let ready = false;
    let spawnCount = 0;
    const launcher = createLauncher({
      isHttpReady: async () => ready,
      waitForHttp: async () => {},
      resolveDshPath: () => '/bin/dsh',
      spawn: () => {
        spawnCount += 1;
        return child;
      },
    });

    const first = await launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' });
    assert.equal(first.reused, false);
    assert.equal(launcher.owned, true);
    assert.equal(launcher.child, child);
    assert.equal(spawnCount, 1);

    ready = true;
    const second = await launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' });
    assert.equal(second.reused, true);
    assert.equal(spawnCount, 1);
    assert.equal(launcher.owned, true);
    assert.equal(launcher.child, child);
    assert.equal(child.killed, false);
  });

  it('spawns when not ready', async () => {
    const child = fakeChild();
    const launcher = createLauncher({
      isHttpReady: async () => false,
      waitForHttp: async () => {},
      resolveDshPath: () => '/bin/dsh',
      spawn: (cmd, args) => {
        assert.equal(cmd, '/bin/dsh');
        assert.deepEqual(args, ['web', '--no-open', '--port', '18789']);
        return child;
      },
    });
    const r = await launcher.start({ port: 18789, baseUrl: 'http://127.0.0.1:18789' });
    assert.equal(r.reused, false);
    assert.equal(launcher.owned, true);
  });

  it('surfaces spawn error without leaving owned orphan', async () => {
    const child = fakeChild();
    const launcher = createLauncher({
      isHttpReady: async () => false,
      waitForHttp: () => new Promise(() => {}),
      resolveDshPath: () => '/missing/dsh',
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
      waitForHttp: async () => {},
      resolveDshPath: () => '/bin/dsh',
      spawn: () => child,
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
      spawn: () => fakeChild(),
    });
    await assert.rejects(
      () => launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' }),
      (err) => err.code === DshErrorCode.NOT_FOUND,
    );
  });

  it('stop uses killTree with SIGTERM then SIGKILL', async () => {
    const child = fakeChild();
    child.pid = 4242;
    child.kill = () => true; // do not auto-exit
    const signals = [];
    const launcher = createLauncher({
      isHttpReady: async () => false,
      diagnoseListen: async () => 'refused',
      waitForHttp: async () => {},
      resolveDshPath: () => '/bin/dsh',
      spawn: () => child,
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
