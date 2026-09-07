const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBootGeneration } = require('../src/boot-generation.js');

describe('boot-generation', () => {
  it('runOnce only fires once per generation', () => {
    const g = createBootGeneration();
    const gen = g.next();
    let n = 0;
    assert.equal(
      g.runOnce(gen, () => {
        n += 1;
      }),
      true,
    );
    assert.equal(
      g.runOnce(gen, () => {
        n += 1;
      }),
      false,
    );
    assert.equal(n, 1);
  });

  it('ignores stale generation after next', () => {
    const g = createBootGeneration();
    const old = g.next();
    g.next();
    let n = 0;
    assert.equal(
      g.runOnce(old, () => {
        n += 1;
      }),
      false,
    );
    assert.equal(n, 0);
  });
});
