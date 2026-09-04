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

  function attachExitHandler(child) {
    child.once('exit', (code, signal) => {
      const wasStopping = state.stopping;
      state.child = null;
      state.owned = false;
      state.stopping = false;
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

  async function stop() {
    if (!state.owned || !state.child) {
      state.owned = false;
      state.child = null;
      state.stopping = false;
      return;
    }

    const child = state.child;
    state.stopping = true;

    if (child.exitCode !== null || child.killed) {
      state.child = null;
      state.owned = false;
      state.stopping = false;
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

    state.child = null;
    state.owned = false;
    state.stopping = false;
  }

  async function start({ port, baseUrl }) {
    if (await isHttpReady(baseUrl)) {
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

    try {
      await waitForHttp(baseUrl);
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
