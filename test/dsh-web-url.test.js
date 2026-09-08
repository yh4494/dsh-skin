'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseDshWebAuthenticatedUrl } = require('../src/dsh-web-url.js');

describe('parseDshWebAuthenticatedUrl', () => {
  it('extracts token URL from the dsh web line', () => {
    const line =
      'dsh web: http://127.0.0.1:18789/?token=tKk9ETAq43SyNyoFMoXKvcqbTXd6VvpRmMBPcWrCwrE\n';
    assert.equal(
      parseDshWebAuthenticatedUrl(line),
      'http://127.0.0.1:18789/?token=tKk9ETAq43SyNyoFMoXKvcqbTXd6VvpRmMBPcWrCwrE',
    );
  });

  it('ignores optional LAN suffix', () => {
    const line =
      'dsh web: http://127.0.0.1:18789/?token=abc (LAN: http://192.168.1.2:18789/?token=abc)\n';
    assert.equal(
      parseDshWebAuthenticatedUrl(line),
      'http://127.0.0.1:18789/?token=abc',
    );
  });

  it('returns null without a token query', () => {
    assert.equal(parseDshWebAuthenticatedUrl('dsh web: http://127.0.0.1:18789/\n'), null);
  });

  it('returns null for unrelated output', () => {
    assert.equal(parseDshWebAuthenticatedUrl('listening on 18789\n'), null);
  });
});
