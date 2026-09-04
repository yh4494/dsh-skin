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
