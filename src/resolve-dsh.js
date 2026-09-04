'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function defaultWhichSync(cmd) {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function defaultNvmCandidates(homedir) {
  const base = path.join(homedir, '.nvm', 'versions', 'node');
  if (!fs.existsSync(base)) return [];
  // Path-sort version dirs (numeric-aware), pick last existing via caller.
  return fs
    .readdirSync(base)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((v) => path.join(base, v, 'bin', 'dsh'))
    .filter((p) => fs.existsSync(p));
}

function resolveDshPath(deps = {}) {
  const env = deps.env ?? process.env;
  const existsSync = deps.existsSync ?? fs.existsSync.bind(fs);
  const whichSync = deps.whichSync ?? defaultWhichSync;
  const homedir = deps.homedir ?? (() => os.homedir());
  const nvmCandidates = deps.nvmCandidates ?? (() => defaultNvmCandidates(homedir()));

  if (env.DSH_BIN && existsSync(env.DSH_BIN)) return env.DSH_BIN;

  const fromWhich = whichSync('dsh');
  if (fromWhich && existsSync(fromWhich)) return fromWhich;

  const nvm = nvmCandidates();
  if (nvm.length > 0) return nvm[nvm.length - 1];

  return null;
}

module.exports = { resolveDshPath };
