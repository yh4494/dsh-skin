'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reclaimDshPort, looksLikeDsh } = require('../src/port-reclaim.js');

describe('port-reclaim', () => {
  it('looksLikeDsh matches dsh command lines', () => {
    assert.equal(looksLikeDsh('node /bin/dsh web --port 18789'), true);
    assert.equal(looksLikeDsh('/usr/local/bin/node .../dsh web'), true);
    assert.equal(looksLikeDsh('nginx: master process'), false);
  });

  it('reclaimDshPort kills dsh listeners and skips empty port', async () => {
    const killed = [];
    const calls = [];
    const execFile = async (file, args) => {
      calls.push([file, args]);
      if (file === 'lsof') {
        if (calls.filter((c) => c[0] === 'lsof').length === 1) {
          return { stdout: '4242\n' };
        }
        return { stdout: '' };
      }
      if (file === 'ps') {
        return { stdout: 'node /Users/yy/.npm-global/bin/dsh web --no-open --port 18789\n' };
      }
      throw new Error(`unexpected ${file}`);
    };
    const result = await reclaimDshPort(18789, {
      execFile,
      kill: (pid, signal) => {
        killed.push([pid, signal]);
      },
      waitMs: 1,
      sleep: async () => {},
    });
    assert.deepEqual(result.killed, [4242]);
    assert.deepEqual(killed[0], [4242, 'SIGTERM']);
  });

  it('reclaimDshPort refuses non-dsh listeners', async () => {
    const execFile = async (file) => {
      if (file === 'lsof') return { stdout: '99\n' };
      if (file === 'ps') return { stdout: 'python3 -m http.server 18789\n' };
      throw new Error(file);
    };
    await assert.rejects(
      () =>
        reclaimDshPort(18789, {
          execFile,
          kill: () => {
            throw new Error('should not kill');
          },
          waitMs: 1,
          sleep: async () => {},
        }),
      (err) => err.code === 'port_busy_non_dsh',
    );
  });
});
