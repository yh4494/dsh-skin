const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLauncher } = require('../src/dsh-launcher.js');

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
});
