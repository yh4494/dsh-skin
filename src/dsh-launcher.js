'use strict';

const { spawn: defaultSpawn } = require('child_process');
const { resolveDshPath: defaultResolveDshPath } = require('./resolve-dsh.js');
const {
  isHttpReady: defaultIsHttpReady,
  waitForHttp: defaultWaitForHttp,
  diagnoseListen: defaultDiagnoseListen,
} = require('./http-ready.js');
const { DshErrorCode, createDshError } = require('./errors.js');

function defaultKillTree(pid, signal, child) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // process may already be gone
    }
  }
}

function createLauncher(deps = {}) {
  const isHttpReady = deps.isHttpReady ?? defaultIsHttpReady;
  const waitForHttp = deps.waitForHttp ?? defaultWaitForHttp;
  const diagnoseListen = deps.diagnoseListen ?? defaultDiagnoseListen;
  const resolveDshPath = deps.resolveDshPath ?? defaultResolveDshPath;
  const spawn = deps.spawn ?? defaultSpawn;
  const killGraceMs = deps.killGraceMs ?? 1500;
  const killTree =
    deps.killTree ??
    ((pid, signal) => defaultKillTree(pid, signal, state.child));

  const state = {
    owned: false,
    child: null,
    stopping: false,
    exitCbs: [],
  };

  function clearChildState() {
    state.child = null;
    state.owned = false;
    state.stopping = false;
  }

  function attachExitHandler(child) {
    child.once('exit', (code, signal) => {
      const wasStopping = state.stopping;
      clearChildState();
      if (!wasStopping) {
        for (const cb of state.exitCbs) {
          try {
            cb(code, signal);
          } catch {
            // ignore listener errors
          }
        }
      }
    });
  }

  function formatSpawnError(err, bin) {
    if (err && err.code === 'ENOENT') {
      return createDshError(
        DshErrorCode.SPAWN_FAILED,
        `Failed to spawn dsh: ${bin} not found (ENOENT)`,
      );
    }
    const detail = err && err.message ? err.message : String(err);
    return createDshError(DshErrorCode.SPAWN_FAILED, `Failed to spawn dsh: ${detail}`);
  }

  async function stop() {
    if (!state.owned || !state.child) {
      clearChildState();
      return;
    }

    const child = state.child;
    state.stopping = true;

    if (child.exitCode !== null || child.killed) {
      clearChildState();
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      child.once('exit', done);
      killTree(child.pid, 'SIGTERM');

      const timer = setTimeout(() => {
        try {
          if (child.exitCode === null) {
            killTree(child.pid, 'SIGKILL');
          }
        } catch {
          // process may already be gone
        }
      }, killGraceMs);
    });

    clearChildState();
  }

  async function start({ port, baseUrl }) {
    if (await isHttpReady(baseUrl)) {
      // Already owned + ready: keep the existing child (do not orphan).
      if (state.owned && state.child) {
        return { reused: true };
      }
      state.owned = false;
      state.child = null;
      return { reused: true };
    }

    const diag = await diagnoseListen(baseUrl);
    if (diag === 'non_http') {
      throw createDshError(DshErrorCode.PORT_BUSY_NON_HTTP, 'port busy non-http');
    }

    const bin = resolveDshPath();
    if (!bin) {
      throw createDshError(DshErrorCode.NOT_FOUND, 'dsh not found');
    }

    const child = spawn(bin, ['web', '--no-open', '--port', String(port)], {
      stdio: 'inherit',
      detached: true,
    });
    state.child = child;
    state.owned = true;
    state.stopping = false;
    attachExitHandler(child);

    const spawnFailed = new Promise((_, reject) => {
      child.once('error', (err) => {
        if (state.child === child) {
          clearChildState();
        }
        reject(formatSpawnError(err, bin));
      });
    });

    try {
      await Promise.race([waitForHttp(baseUrl), spawnFailed]);
    } catch (err) {
      await stop();
      if (err && err.code === DshErrorCode.SPAWN_FAILED) {
        throw err;
      }
      if (err && err.message === 'dsh did not become ready in time') {
        throw createDshError(DshErrorCode.TIMEOUT, 'dsh did not become ready in time');
      }
      throw err;
    }

    return { reused: false };
  }

  return {
    get owned() {
      return state.owned;
    },
    get child() {
      return state.child;
    },
    onExit(cb) {
      state.exitCbs.push(cb);
    },
    start,
    stop,
  };
}

module.exports = { createLauncher };
