const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDshPath } = require('../src/resolve-dsh.js');

describe('resolveDshPath', () => {
  it('prefers DSH_BIN when file exists', () => {
    const resolved = resolveDshPath({
      env: { DSH_BIN: '/custom/dsh' },
      existsSync: (p) => p === '/custom/dsh',
      whichSync: () => '/usr/bin/dsh',
      homedir: () => '/Users/x',
    });
    assert.equal(resolved, '/custom/dsh');
  });

  it('uses which when DSH_BIN missing and which path exists', () => {
    const resolved = resolveDshPath({
      env: {},
      existsSync: (p) => p === '/opt/homebrew/bin/dsh',
      whichSync: () => '/opt/homebrew/bin/dsh',
      homedir: () => '/Users/x',
      nvmCandidates: () => [],
    });
    assert.equal(resolved, '/opt/homebrew/bin/dsh');
  });

  it('falls through to nvm when which path does not exist', () => {
    const resolved = resolveDshPath({
      env: {},
      existsSync: (p) => p === '/nvm/v20/bin/dsh',
      whichSync: () => '/stale/dsh',
      homedir: () => '/Users/x',
      nvmCandidates: () => ['/nvm/v18/bin/dsh', '/nvm/v20/bin/dsh'],
    });
    assert.equal(resolved, '/nvm/v20/bin/dsh');
  });

  it('returns null when nothing found', () => {
    const resolved = resolveDshPath({
      env: {},
      existsSync: () => false,
      whichSync: () => null,
      homedir: () => '/Users/x',
      nvmCandidates: () => [],
    });
    assert.equal(resolved, null);
  });

  it('default nvm scan picks path-sorted last existing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nvm-'));
    try {
      const nodeBase = path.join(root, '.nvm', 'versions', 'node');
      for (const ver of ['v20.10.0', 'v18.19.0', 'v22.1.0']) {
        const binDir = path.join(nodeBase, ver, 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'dsh'), '#!/bin/sh\n');
      }
      // Middle version missing binary should be skipped by filter; last sorted wins.
      fs.unlinkSync(path.join(nodeBase, 'v20.10.0', 'bin', 'dsh'));

      const resolved = resolveDshPath({
        env: {},
        whichSync: () => null,
        homedir: () => root,
      });
      assert.equal(resolved, path.join(nodeBase, 'v22.1.0', 'bin', 'dsh'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
