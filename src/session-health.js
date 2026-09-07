'use strict';

const { isHttpReady } = require('./http-ready.js');

function createSessionHealth(deps = {}) {
  const probe = deps.probe ?? ((url) => isHttpReady(url, { attempts: 1 }));
  const intervalMs = deps.intervalMs ?? 2500;
  const failureThreshold = deps.failureThreshold ?? 3;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;

  let timer = null;
  let stopped = true;
  let consecutiveFailures = 0;
  let epoch = 0;

  function stop() {
    stopped = true;
    consecutiveFailures = 0;
    if (timer != null) {
      clearIntervalFn(timer);
      timer = null;
    }
    epoch += 1;
  }

  function start(baseUrl, onUnhealthy) {
    stop();
    stopped = false;
    const myEpoch = epoch;
    consecutiveFailures = 0;

    timer = setIntervalFn(async () => {
      if (stopped || myEpoch !== epoch) return;
      let ok = false;
      try {
        ok = await probe(baseUrl);
      } catch {
        ok = false;
      }
      if (stopped || myEpoch !== epoch) return;
      if (ok) {
        consecutiveFailures = 0;
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        stop();
        onUnhealthy('unreachable');
      }
    }, intervalMs);
  }

  return { start, stop };
}

module.exports = { createSessionHealth };
