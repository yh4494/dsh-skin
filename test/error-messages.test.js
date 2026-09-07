const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DshErrorCode, createDshError } = require('../src/errors.js');
const { messageForError } = require('../src/error-messages.js');

describe('error-messages', () => {
  it('maps known codes to Chinese hints', () => {
    assert.match(
      messageForError(createDshError(DshErrorCode.NOT_FOUND, 'x')),
      /未找到|DSH_BIN|dsh/,
    );
    assert.match(
      messageForError(createDshError(DshErrorCode.PORT_BUSY_NON_HTTP, 'x')),
      /占用|DSH_SKIN_PORT/,
    );
    assert.match(
      messageForError(createDshError(DshErrorCode.UNREACHABLE, 'x')),
      /不可达|服务/,
    );
  });

  it('falls back for unknown errors', () => {
    assert.equal(messageForError(new Error('boom')), 'boom');
  });
});
