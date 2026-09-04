const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDshPath } = require('../src/resolve-dsh.js');

describe('resolveDshPath', () => {
  it('prefers DSH_BIN when file exists', () => {
    const path = resolveDshPath({
      env: { DSH_BIN: '/custom/dsh' },
      existsSync: (p) => p === '/custom/dsh',
      whichSync: () => '/usr/bin/dsh',
      homedir: () => '/Users/x',
    });
    assert.equal(path, '/custom/dsh');
  });

  it('uses which when DSH_BIN missing', () => {
    const path = resolveDshPath({
      env: {},
      existsSync: () => false,
      whichSync: () => '/opt/homebrew/bin/dsh',
      homedir: () => '/Users/x',
    });
    assert.equal(path, '/opt/homebrew/bin/dsh');
  });

  it('returns null when nothing found', () => {
    const path = resolveDshPath({
      env: {},
      existsSync: () => false,
      whichSync: () => null,
      homedir: () => '/Users/x',
      nvmCandidates: () => [],
    });
    assert.equal(path, null);
  });
});
