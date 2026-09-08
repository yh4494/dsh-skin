'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function defaultExecFile(file, args, opts) {
  return execFileAsync(file, args, opts);
}

async function listListenPids(port, execFileFn = defaultExecFile) {
  try {
    const { stdout } = await execFileFn('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-t',
    ]);
    return String(stdout)
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch (err) {
    // lsof exits 1 when nothing matches
    if (err && (err.code === 1 || err.status === 1)) return [];
    throw err;
  }
}

async function readCommandLine(pid, execFileFn = defaultExecFile) {
  try {
    const { stdout } = await execFileFn('ps', ['-p', String(pid), '-o', 'command=']);
    return String(stdout).trim();
  } catch {
    return '';
  }
}

function looksLikeDsh(command) {
  return /\bdsh\b/.test(command);
}

/**
 * SIGTERM (then SIGKILL) listeners on `port` whose command line looks like dsh.
 * Refuses to kill unrelated processes.
 */
async function reclaimDshPort(port, deps = {}) {
  const execFileFn = deps.execFile ?? defaultExecFile;
  const killFn = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const waitMs = deps.waitMs ?? 400;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const pids = await listListenPids(port, execFileFn);
  if (pids.length === 0) return { killed: [] };

  const killed = [];
  for (const pid of pids) {
    const cmd = await readCommandLine(pid, execFileFn);
    if (!looksLikeDsh(cmd)) {
      const err = new Error(`port ${port} held by non-dsh process: ${cmd || pid}`);
      err.code = 'port_busy_non_dsh';
      throw err;
    }
    try {
      killFn(pid, 'SIGTERM');
      killed.push(pid);
    } catch {
      // already gone
    }
  }

  await sleep(waitMs);
  const still = await listListenPids(port, execFileFn);
  for (const pid of still) {
    try {
      killFn(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await sleep(waitMs);
  return { killed };
}

module.exports = { reclaimDshPort, listListenPids, looksLikeDsh };
