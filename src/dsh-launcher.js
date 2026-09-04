'use strict';

const { spawn: defaultSpawn } = require('child_process');
const { resolveDshPath: defaultResolveDshPath } = require('./resolve-dsh.js');
const { isHttpReady: defaultIsHttpReady, waitForHttp: defaultWaitForHttp } = require('./http-ready.js');

function createLauncher(deps = {}) {
  const isHttpReady = deps.isHttpReady ?? defaultIsHttpReady;
  const waitForHttp = deps.waitForHttp ?? defaultWaitForHttp;
  const resolveDshPath = deps.resolveDshPath ?? defaultResolveDshPath;
  const spawn = deps.spawn ?? defaultSpawn;
  const killGraceMs = deps.killGraceMs ?? 1500;

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
      return new Error(`Failed to spawn dsh: ${bin} not found (ENOENT)`);
    }
    const detail = err && err.message ? err.message : String(err);
    return new Error(`Failed to spawn dsh: ${detail}`);
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
      child.kill('SIGTERM');

      const timer = setTimeout(() => {
        try {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
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

    const bin = resolveDshPath();
    if (!bin) {
      throw new Error('dsh not found');
    }

    const child = spawn(bin, ['web', '--no-open', '--port', String(port)], {
      stdio: 'inherit',
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
