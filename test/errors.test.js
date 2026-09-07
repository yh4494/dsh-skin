const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DshErrorCode, createDshError } = require('../src/errors.js');

describe('errors', () => {
  it('createDshError sets code and message', () => {
    const err = createDshError(DshErrorCode.NOT_FOUND, 'dsh not found');
    assert.equal(err.code, 'not_found');
    assert.equal(err.message, 'dsh not found');
  });
});
