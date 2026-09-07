const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionHealth } = require('../src/session-health.js');

describe('session-health', () => {
  it('calls onUnhealthy after failureThreshold consecutive failures', async () => {
    const calls = [];
    const timers = [];
    const health = createSessionHealth({
      intervalMs: 5,
      failureThreshold: 3,
      probe: async () => false,
      setIntervalFn: (fn, ms) => {
        const id = { fn, ms };
        timers.push(id);
        return id;
      },
      clearIntervalFn: (id) => {
        const i = timers.indexOf(id);
        if (i >= 0) timers.splice(i, 1);
      },
    });

    health.start('http://127.0.0.1:9', (reason) => calls.push(reason));
    assert.equal(timers.length, 1);
    await timers[0].fn();
    await timers[0].fn();
    assert.equal(calls.length, 0);
    await timers[0].fn();
    assert.deepEqual(calls, ['unreachable']);
    assert.equal(timers.length, 0);
  });

  it('stop prevents further callbacks', async () => {
    const calls = [];
    let probeDone;
    const probeGate = new Promise((r) => {
      probeDone = r;
    });
    const health = createSessionHealth({
      intervalMs: 5,
      failureThreshold: 1,
      probe: async () => {
        await probeGate;
        return false;
      },
      setIntervalFn: (fn) => {
        queueMicrotask(fn);
        return 1;
      },
      clearIntervalFn: () => {},
    });
    health.start('http://127.0.0.1:9', (r) => calls.push(r));
    health.stop();
    probeDone();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 0);
  });
});
