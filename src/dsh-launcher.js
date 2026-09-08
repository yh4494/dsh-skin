'use strict';

const { spawn: defaultSpawn } = require('child_process');
const { resolveDshPath: defaultResolveDshPath } = require('./resolve-dsh.js');
const {
  isHttpReady: defaultIsHttpReady,
  waitForHttp: defaultWaitForHttp,
  diagnoseListen: defaultDiagnoseListen,
} = require('./http-ready.js');
const { parseDshWebAuthenticatedUrl } = require('./dsh-web-url.js');
const { reclaimDshPort: defaultReclaimDshPort } = require('./port-reclaim.js');
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

function attachOutputCapture(child, onAuthenticatedUrl) {
  let stdoutBuf = '';
  let resolved = false;

  const consider = (chunk, stream) => {
    stream.write(chunk);
    if (resolved) return;
    stdoutBuf += chunk;
    // Keep a bounded tail so a long-running process cannot grow this forever.
    if (stdoutBuf.length > 64 * 1024) {
      stdoutBuf = stdoutBuf.slice(-32 * 1024);
    }
    const url = parseDshWebAuthenticatedUrl(stdoutBuf);
    if (url) {
      resolved = true;
      onAuthenticatedUrl(url);
    }
  };

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => consider(chunk, process.stdout));
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  }
}

function createLauncher(deps = {}) {
  const isHttpReady = deps.isHttpReady ?? defaultIsHttpReady;
  const waitForHttp = deps.waitForHttp ?? defaultWaitForHttp;
  const diagnoseListen = deps.diagnoseListen ?? defaultDiagnoseListen;
  const resolveDshPath = deps.resolveDshPath ?? defaultResolveDshPath;
  const reclaimDshPort = deps.reclaimDshPort ?? defaultReclaimDshPort;
  const spawn = deps.spawn ?? defaultSpawn;
  const killGraceMs = deps.killGraceMs ?? 1500;
  const urlGraceMs = deps.urlGraceMs ?? 5000;
  const killTree =
    deps.killTree ??
    ((pid, signal) => defaultKillTree(pid, signal, state.child));

  const state = {
    owned: false,
    child: null,
    stopping: false,
    exitCbs: [],
    appUrl: null,
  };

  function clearChildState() {
    state.child = null;
    state.owned = false;
    state.stopping = false;
    state.appUrl = null;
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

  /**
   * Always own a fresh dsh: stop any prior owned child, kill leftover dsh on
   * the target port, then spawn and capture the launch-token URL.
   */
  async function start({ port, baseUrl }) {
    await stop();

    if (await isHttpReady(baseUrl)) {
      try {
        await reclaimDshPort(port);
      } catch (err) {
        if (err && err.code === 'port_busy_non_dsh') {
          throw createDshError(DshErrorCode.PORT_BUSY_NON_HTTP, err.message);
        }
        throw err;
      }
    } else {
      const diag = await diagnoseListen(baseUrl);
      if (diag === 'non_http') {
        throw createDshError(DshErrorCode.PORT_BUSY_NON_HTTP, 'port busy non-http');
      }
    }

    // Port may still look ready briefly after reclaim; refuse to "reuse".
    if (await isHttpReady(baseUrl)) {
      throw createDshError(
        DshErrorCode.PORT_BUSY_NON_HTTP,
        'port still busy after reclaim',
      );
    }

    const bin = resolveDshPath();
    if (!bin) {
      throw createDshError(DshErrorCode.NOT_FOUND, 'dsh not found');
    }

    const child = spawn(bin, ['web', '--no-open', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    state.child = child;
    state.owned = true;
    state.stopping = false;
    state.appUrl = null;
    attachExitHandler(child);

    let resolveUrl;
    const urlPromise = new Promise((resolve) => {
      resolveUrl = resolve;
    });
    attachOutputCapture(child, (url) => {
      state.appUrl = url;
      resolveUrl(url);
    });

    const spawnFailed = new Promise((_, reject) => {
      child.once('error', (err) => {
        if (state.child === child) {
          clearChildState();
        }
        reject(formatSpawnError(err, bin));
      });
    });

    try {
      await Promise.race([
        (async () => {
          await waitForHttp(baseUrl);
          const url = await Promise.race([
            urlPromise,
            new Promise((resolve) => {
              setTimeout(() => resolve(null), urlGraceMs);
            }),
          ]);
          if (url) {
            state.appUrl = url;
            return;
          }
          // Older dsh without launch-token auth: fall back to bare base URL.
          state.appUrl = baseUrl;
        })(),
        spawnFailed,
      ]);
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

    return { reused: false, appUrl: state.appUrl || baseUrl };
  }

  return {
    get owned() {
      return state.owned;
    },
    get child() {
      return state.child;
    },
    get appUrl() {
      return state.appUrl;
    },
    onExit(cb) {
      state.exitCbs.push(cb);
    },
    start,
    stop,
  };
}

module.exports = { createLauncher };
