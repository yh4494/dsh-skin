'use strict';

function createBootGeneration() {
  let current = 0;
  const handled = new Set();

  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(gen) {
      return gen === current;
    },
    runOnce(gen, fn) {
      if (gen !== current) return false;
      if (handled.has(gen)) return false;
      handled.add(gen);
      fn();
      return true;
    },
  };
}

module.exports = { createBootGeneration };
