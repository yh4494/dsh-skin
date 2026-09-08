'use strict';

const DshErrorCode = Object.freeze({
  NOT_FOUND: 'not_found',
  SPAWN_FAILED: 'spawn_failed',
  PORT_BUSY_NON_HTTP: 'port_busy_non_http',
  TIMEOUT: 'timeout',
  DSH_EXITED: 'dsh_exited',
  UNREACHABLE: 'unreachable',
  RENDERER_FAILED: 'renderer_failed',
  AUTH_REQUIRED: 'auth_required',
});

function createDshError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { DshErrorCode, createDshError };
