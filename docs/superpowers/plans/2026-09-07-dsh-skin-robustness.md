# dsh-skin Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 dsh-skin 增加运行期韧性：分类启动诊断、进程组清理、SessionHealth 监控外部/本地服务掉线、窗口故障一次静默重载、错误去重与最小化 hide。

**Architecture:** 在既有「可测纯逻辑 + `main.js` 胶水」上新增 `errors` / `session-health` / 端口诊断扩展；`dsh-launcher` 负责分类错误与进程组 stop；`main.js` 用 generation 统一 `onUnhealthy` → 错误页，窗口事件最多静默 reload 一次。不做 dsh 指纹、不做无限自动重启、不改 dsh 本体。

**Tech Stack:** Electron、Node 内置 `node:test` + `node:assert/strict`、macOS（Unix 进程组）。

**Spec:** [`docs/superpowers/specs/2026-09-07-dsh-skin-robustness-design.md`](../specs/2026-09-07-dsh-skin-robustness-design.md)

## Global Constraints

- 平台：仅 macOS / Unix 进程组语义；进程组失败时回退 `child.kill` 并保持可测注入
- 健康默认：间隔 `2500ms`，连续失败阈值 `3`
- 窗口自动 reload：成功 load 后计数重置，至多 **1** 次静默重载
- 同一 boot generation 内 `onUnhealthy`：**只处理第一次**
- 复用外部 dsh（`owned=false`）时，退出 **不** 杀外部进程
- 不修改 `~/.dsh`、不做设置页、不做深度 dsh 指纹、不做 Electron E2E
- 错误对象使用稳定 `err.code` 字符串（见 Task 1）；用户文案中文
- 用户未要求时可跳过各 Task 的 commit，但文件与测试必须完成；若提交，message 用英文、聚焦 why

---

## File Map

| File | Responsibility |
|------|----------------|
| `src/errors.js` | `DshErrorCode` 常量 + `createDshError(code, message)` |
| `src/error-messages.js` | `messageForError(err)` → 用户可见中文 |
| `src/http-ready.js` | 现有 ready；新增 `diagnoseListen(baseUrl)` |
| `src/dsh-launcher.js` | 分类抛错、进程组 spawn/stop、注入 `killTree` |
| `src/session-health.js` | 周期 probe、阈值、`onUnhealthy`、`stop` 后静默 |
| `src/boot-generation.js` | 极小 generation 守卫（可单测去重） |
| `src/main.js` | 接线 health、窗口事件、minimize hide、文案、quit 顺序 |
| `src/loading.html` | 不改结构（仍用 `?error=`）；必要时微调样式即可 |
| `test/errors.test.js` | code + createDshError |
| `test/error-messages.test.js` | 文案映射 |
| `test/http-ready.test.js` | diagnoseListen 用例追加 |
| `test/dsh-launcher.test.js` | 分类错误、killTree 钩子回归 |
| `test/session-health.test.js` | 阈值 / stop |
| `test/boot-generation.test.js` | 只接受当前 generation |
| `README.md` | 行为摘要同步 |

---

### Task 1: 错误码与用户文案

**Files:**
- Create: `src/errors.js`
- Create: `src/error-messages.js`
- Create: `test/errors.test.js`
- Create: `test/error-messages.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `DshErrorCode`: `{ NOT_FOUND, SPAWN_FAILED, PORT_BUSY_NON_HTTP, TIMEOUT, DSH_EXITED, UNREACHABLE, RENDERER_FAILED }`，值分别为 `'not_found' | 'spawn_failed' | 'port_busy_non_http' | 'timeout' | 'dsh_exited' | 'unreachable' | 'renderer_failed'`
  - `createDshError(code: string, message: string): Error` — `error.code === code`，`error.message === message`（message 可为英文技术细节，展示层再映射）
  - `messageForError(err: unknown): string` — 按 `err.code` 返回中文；未知则 `String(err.message || err)`

- [ ] **Step 1: 写失败单测**

```js
// test/errors.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DshErrorCode, createDshError } = require('../src/errors.js');

describe('errors', () => {
  it('createDshError sets code and message', () => {
    const err = createDshError(DshErrorCode.NOT_FOUND, 'dsh not found');
    assert.equal(err.code, 'not_found');
    assert.equal(err.message, 'dsh not found');
  });
});
```

```js
// test/error-messages.test.js
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
```

- [ ] **Step 2: 跑测确认失败**

Run: `node --test test/errors.test.js test/error-messages.test.js`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```js
// src/errors.js
'use strict';

const DshErrorCode = Object.freeze({
  NOT_FOUND: 'not_found',
  SPAWN_FAILED: 'spawn_failed',
  PORT_BUSY_NON_HTTP: 'port_busy_non_http',
  TIMEOUT: 'timeout',
  DSH_EXITED: 'dsh_exited',
  UNREACHABLE: 'unreachable',
  RENDERER_FAILED: 'renderer_failed',
});

function createDshError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { DshErrorCode, createDshError };
```

```js
// src/error-messages.js
'use strict';

const { DshErrorCode } = require('./errors.js');

const MESSAGES = {
  [DshErrorCode.NOT_FOUND]:
    '未找到 dsh。请先安装 @deepseek-ai/dsh，或设置环境变量 DSH_BIN 为可执行文件路径。',
  [DshErrorCode.SPAWN_FAILED]:
    '启动 dsh 失败。请检查 DSH_BIN / 安装是否完整后重试。',
  [DshErrorCode.PORT_BUSY_NON_HTTP]:
    '目标端口已被其它程序占用（非 HTTP）。请更换 DSH_SKIN_PORT 或释放该端口后重试。',
  [DshErrorCode.TIMEOUT]:
    'dsh web 未在时限内就绪。请查看终端中 dsh 日志后重试。',
  [DshErrorCode.DSH_EXITED]: 'dsh 已退出。可点击重试重新启动。',
  [DshErrorCode.UNREACHABLE]:
    '本地服务不可达（可能已停止）。可点击重试。',
  [DshErrorCode.RENDERER_FAILED]: '页面加载失败。可点击重试。',
};

function messageForError(err) {
  if (err && err.code && MESSAGES[err.code]) return MESSAGES[err.code];
  if (err && err.message) return String(err.message);
  return String(err);
}

module.exports = { messageForError };
```

- [ ] **Step 4: 跑测确认通过**

Run: `node --test test/errors.test.js test/error-messages.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/errors.js src/error-messages.js test/errors.test.js test/error-messages.test.js
git commit -m "$(cat <<'EOF'
feat: add dsh error codes and Chinese user messages

Stable err.code values let launcher and UI share one mapping.
EOF
)"
```

---

### Task 2: `diagnoseListen` 端口诊断

**Files:**
- Modify: `src/http-ready.js`
- Modify: `test/http-ready.test.js`

**Interfaces:**
- Consumes: 无新模块
- Produces:
  - `diagnoseListen(baseUrl: string, opts?: { timeoutMs?: number, connect?: Function, probeHttp?: Function }): Promise<'ready' | 'refused' | 'non_http' | 'unknown'>`
  - 语义：`ready` = HTTP 探测成功；`refused` = TCP/连接被拒或无监听；`non_http` = TCP 可连但 HTTP 探测失败；`unknown` = 其它
  - 默认实现可用 `net.connect` + 现有 `isHttpReady`；测试通过注入 `connect` / `probeHttp` 完成，避免 flake

- [ ] **Step 1: 写失败单测（追加到现有文件）**

```js
// 追加到 test/http-ready.test.js
const { diagnoseListen } = require('../src/http-ready.js');

describe('diagnoseListen', () => {
  it('returns ready when HTTP probe succeeds', async () => {
    const status = await diagnoseListen('http://127.0.0.1:9', {
      connect: async () => {},
      probeHttp: async () => true,
    });
    assert.equal(status, 'ready');
  });

  it('returns refused when connect fails with ECONNREFUSED', async () => {
    const status = await diagnoseListen('http://127.0.0.1:9', {
      connect: async () => {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
      probeHttp: async () => true,
    });
    assert.equal(status, 'refused');
  });

  it('returns non_http when TCP connects but HTTP fails', async () => {
    const status = await diagnoseListen('http://127.0.0.1:9', {
      connect: async () => {},
      probeHttp: async () => false,
    });
    assert.equal(status, 'non_http');
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `node --test test/http-ready.test.js`  
Expected: FAIL（`diagnoseListen` 未导出）

- [ ] **Step 3: 实现**

在 `src/http-ready.js` 增加（保持现有 `isHttpReady` / `waitForHttp` 行为不变）。注入路径须稳定满足：`connect` 成功 + `probeHttp` false → `non_http`；`ECONNREFUSED` → `refused`；`probeHttp` true → `ready`。

```js
const net = require('node:net');

function defaultConnect(hostname, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostname, port }, () => {
      socket.destroy();
      resolve();
    });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    socket.on('error', reject);
  });
}

async function diagnoseListen(baseUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1500;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'unknown';
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const hostname = url.hostname;
  const connect = opts.connect
    ? (h, p) => opts.connect(h, p)
    : (h, p) => defaultConnect(h, p, timeoutMs);
  const probeHttp =
    opts.probeHttp ?? ((u) => isHttpReady(u, { timeoutMs, attempts: 1 }));

  // Prefer HTTP success as ready even before classifying TCP.
  if (await probeHttp(baseUrl)) return 'ready';

  try {
    await connect(hostname, port);
    return 'non_http';
  } catch (err) {
    if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT')) {
      return 'refused';
    }
    return 'unknown';
  }
}

module.exports = { isHttpReady, waitForHttp, diagnoseListen };
```

注意：上表注入测里「connect 抛 ECONNREFUSED」时，若先跑 `probeHttp` 且其返回 `true` 会得到 `ready`。单测里对该用例令 `probeHttp: async () => false`，再断言 `refused`。

修正后的 refused 用例：

```js
it('returns refused when connect fails with ECONNREFUSED', async () => {
  const status = await diagnoseListen('http://127.0.0.1:9', {
    connect: async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    },
    probeHttp: async () => false,
  });
  assert.equal(status, 'refused');
});
```

- [ ] **Step 4: 跑全量 http 测**

Run: `node --test test/http-ready.test.js`  
Expected: PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add src/http-ready.js test/http-ready.test.js
git commit -m "$(cat <<'EOF'
feat: diagnose listen state for non-HTTP port conflicts

Distinguish refused vs TCP-up-but-not-HTTP before spawn.
EOF
)"
```

---

### Task 3: launcher 分类错误 + 进程组 stop

**Files:**
- Modify: `src/dsh-launcher.js`
- Modify: `test/dsh-launcher.test.js`

**Interfaces:**
- Consumes: `createDshError`, `DshErrorCode`；`diagnoseListen`；现有 `isHttpReady` / `waitForHttp` / `resolveDshPath`
- Produces（变更点）:
  - `createLauncher(deps)` 新增可选 `diagnoseListen`、`killTree(pid, signal)`（默认：`process.kill(-pid, signal)`，失败则 `child.kill(signal)`）
  - `start`：若未 ready，先 `diagnoseListen`；若 `'non_http'` → throw `createDshError(PORT_BUSY_NON_HTTP, …)`；`resolveDshPath` 空 → `NOT_FOUND`；spawn error → `SPAWN_FAILED`；`waitForHttp` 超时 → 包装为 `TIMEOUT`
  - `spawn` 选项增加 `detached: true`；`stop` 对 `child.pid` 调用 `killTree`
  - 既有 reuse / owned 不 orphan 行为必须保持

- [ ] **Step 1: 写失败单测（追加）**

```js
const { DshErrorCode } = require('../src/errors.js');

it('throws PORT_BUSY_NON_HTTP when diagnose says non_http', async () => {
  const launcher = createLauncher({
    isHttpReady: async () => false,
    diagnoseListen: async () => 'non_http',
    resolveDshPath: () => '/bin/dsh',
    spawn: () => {
      throw new Error('should not spawn');
    },
  });
  await assert.rejects(
    () => launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' }),
    (err) => err.code === DshErrorCode.PORT_BUSY_NON_HTTP,
  );
});

it('throws NOT_FOUND with code when bin missing', async () => {
  const launcher = createLauncher({
    isHttpReady: async () => false,
    diagnoseListen: async () => 'refused',
    resolveDshPath: () => null,
    spawn: () => fakeChild(),
  });
  await assert.rejects(
    () => launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' }),
    (err) => err.code === DshErrorCode.NOT_FOUND,
  );
});

it('stop uses killTree with SIGTERM then SIGKILL', async () => {
  const child = fakeChild();
  child.pid = 4242;
  child.kill = () => true; // do not auto-exit
  const signals = [];
  const launcher = createLauncher({
    isHttpReady: async () => false,
    diagnoseListen: async () => 'refused',
    waitForHttp: async () => {},
    resolveDshPath: () => '/bin/dsh',
    spawn: () => child,
    killGraceMs: 20,
    killTree: (pid, sig) => {
      signals.push([pid, sig]);
      if (sig === 'SIGKILL') {
        child.exitCode = 0;
        queueMicrotask(() => child.emit('exit', 0, sig));
      }
    },
  });
  await launcher.start({ port: 1, baseUrl: 'http://127.0.0.1:1' });
  await launcher.stop();
  assert.deepEqual(signals[0], [4242, 'SIGTERM']);
  assert.equal(signals.at(-1)[1], 'SIGKILL');
});
```

- [ ] **Step 2: 跑测确认新用例失败**

Run: `node --test test/dsh-launcher.test.js`  
Expected: 新用例 FAIL

- [ ] **Step 3: 实现 launcher 变更**

要点写入 `src/dsh-launcher.js`：

```js
const { diagnoseListen: defaultDiagnoseListen } = require('./http-ready.js');
const { DshErrorCode, createDshError } = require('./errors.js');

// deps: diagnoseListen, killTree
// defaultKillTree(pid, signal, child):
//   try process.kill(-pid, signal); catch child.kill(signal)

// start after !isHttpReady:
//   diag === 'non_http' → createDshError(PORT_BUSY_NON_HTTP, 'port busy non-http')
//   !bin → createDshError(NOT_FOUND, 'dsh not found')
//   spawn(bin, args, { stdio: 'inherit', detached: true })
//   waitForHttp timeout → createDshError(TIMEOUT, 'dsh did not become ready in time')
//   spawn error → createDshError(SPAWN_FAILED, ...)

// stop: killTree(child.pid, 'SIGTERM') then grace → killTree(..., 'SIGKILL')
```

保留：owned+ready 不 orphan；`onExit` 仅在非 `stopping` 时触发。

- [ ] **Step 4: 跑 launcher 全测**

Run: `node --test test/dsh-launcher.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dsh-launcher.js test/dsh-launcher.test.js
git commit -m "$(cat <<'EOF'
feat: classify launcher errors and stop process groups

Use diagnoseListen before spawn and killTree on owned stop.
EOF
)"
```

---

### Task 4: SessionHealth

**Files:**
- Create: `src/session-health.js`
- Create: `test/session-health.test.js`

**Interfaces:**
- Consumes: 可注入 `probe(url) => Promise<boolean>`（默认 `isHttpReady`）
- Produces:
  - `createSessionHealth(deps?: { probe?, intervalMs?, failureThreshold?, setIntervalFn?, clearIntervalFn? })`
  - 返回 `{ start(baseUrl: string, onUnhealthy: (reason: string) => void): void, stop(): void }`
  - 默认 `intervalMs=2500`，`failureThreshold=3`
  - `start` 先 `stop`；连续失败达阈值调用一次 `onUnhealthy('unreachable')` 并 `stop`
  - `stop` 后 in-flight probe 不得再回调

- [ ] **Step 1: 写失败单测**

```js
// test/session-health.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionHealth } = require('../src/session-health.js');

describe('session-health', () => {
  it('calls onUnhealthy after failureThreshold consecutive failures', async () => {
    const calls = [];
    const timers = [];
    const health = createSessionHealth({
      intervalMs: 5,
      failureThreshold: 3,
      probe: async () => false,
      setIntervalFn: (fn, ms) => {
        const id = { fn, ms };
        timers.push(id);
        return id;
      },
      clearIntervalFn: (id) => {
        const i = timers.indexOf(id);
        if (i >= 0) timers.splice(i, 1);
      },
    });

    health.start('http://127.0.0.1:9', (reason) => calls.push(reason));
    assert.equal(timers.length, 1);
    await timers[0].fn();
    await timers[0].fn();
    assert.equal(calls.length, 0);
    await timers[0].fn();
    assert.deepEqual(calls, ['unreachable']);
    assert.equal(timers.length, 0);
  });

  it('stop prevents further callbacks', async () => {
    const calls = [];
    let probeDone;
    const probeGate = new Promise((r) => {
      probeDone = r;
    });
    const health = createSessionHealth({
      intervalMs: 5,
      failureThreshold: 1,
      probe: async () => {
        await probeGate;
        return false;
      },
      setIntervalFn: (fn) => {
        queueMicrotask(fn);
        return 1;
      },
      clearIntervalFn: () => {},
    });
    health.start('http://127.0.0.1:9', (r) => calls.push(r));
    health.stop();
    probeDone();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 0);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `node --test test/session-health.test.js`  
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// src/session-health.js
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
```

- [ ] **Step 4: 跑测通过**

Run: `node --test test/session-health.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session-health.js test/session-health.test.js
git commit -m "$(cat <<'EOF'
feat: add SessionHealth polling with failure threshold

Notify once when local HTTP becomes unreachable.
EOF
)"
```

---

### Task 5: boot generation 守卫

**Files:**
- Create: `src/boot-generation.js`
- Create: `test/boot-generation.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `createBootGeneration()` → `{ next(): number, isCurrent(gen: number): boolean, runOnce(gen: number, fn: () => void): boolean }`
  - `runOnce`：非当前 gen → `false`；当前且未处理 → 执行 `fn` 一次并 `true`；同 gen 再调用 → `false`

- [ ] **Step 1: 写失败单测**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBootGeneration } = require('../src/boot-generation.js');

describe('boot-generation', () => {
  it('runOnce only fires once per generation', () => {
    const g = createBootGeneration();
    const gen = g.next();
    let n = 0;
    assert.equal(
      g.runOnce(gen, () => {
        n += 1;
      }),
      true,
    );
    assert.equal(
      g.runOnce(gen, () => {
        n += 1;
      }),
      false,
    );
    assert.equal(n, 1);
  });

  it('ignores stale generation after next', () => {
    const g = createBootGeneration();
    const old = g.next();
    g.next();
    let n = 0;
    assert.equal(
      g.runOnce(old, () => {
        n += 1;
      }),
      false,
    );
    assert.equal(n, 0);
  });
});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**

```js
// src/boot-generation.js
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
```

Run: `node --test test/boot-generation.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/boot-generation.js test/boot-generation.test.js
git commit -m "$(cat <<'EOF'
feat: add boot generation guard for single error display

Prevent duplicate error pages during racey boot failures.
EOF
)"
```

---

### Task 6: 接线 `main.js`（health、窗口、minimize、文案）

**Files:**
- Modify: `src/main.js`
- Modify: `README.md`（行为摘要）

**Interfaces:**
- Consumes: Task 1–5 全部导出
- Produces: 运行时行为（无新导出）

行为清单：

1. `health = createSessionHealth()`；`bootGen = createBootGeneration()`；`activeGen`；`autoReloadUsed`
2. `reportUnhealthy(gen, err)`：`health.stop()` + `bootGen.runOnce` → `showLoadingError(messageForError(err))`
3. `bootDsh`：`health.stop()`；`activeGen = bootGen.next()`；`autoReloadUsed = false`；失败 `reportUnhealthy`；`loadURL` 成功后 `health.start`
4. `launcher.onExit` → `reportUnhealthy(activeGen, DSH_EXITED)`
5. `did-fail-load` / `render-process-gone`：忽略 loading `file:`；否则 reload 至多 1 次，再 `RENDERER_FAILED`
6. **选定：** `autoReloadUsed` 仅在每次 `bootDsh` 开头重置；自动 reload 消耗后直到下次 boot 不再重置
7. `minimize` → `hide`
8. `before-quit`：先 `health.stop()` 再 `launcher.stop()`
9. 用户可见错误一律 `messageForError`

- [ ] **Step 1: 按清单改 `main.js`**

```js
const { createSessionHealth } = require('./session-health');
const { createBootGeneration } = require('./boot-generation');
const { DshErrorCode, createDshError } = require('./errors');
const { messageForError } = require('./error-messages');

const health = createSessionHealth();
const bootGen = createBootGeneration();
let activeGen = 0;
let autoReloadUsed = false;

function reportUnhealthy(gen, err) {
  health.stop();
  bootGen.runOnce(gen, () => {
    showLoadingError(messageForError(err));
  });
}

async function bootDsh() {
  if (bootInFlight) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  bootInFlight = true;
  health.stop();
  activeGen = bootGen.next();
  autoReloadUsed = false;
  const gen = activeGen;
  try {
    const port = getPort();
    const baseUrl = getBaseUrl(port);
    await mainWindow.loadFile(loadingPath);
    try {
      await launcher.start({ port, baseUrl });
      if (!mainWindow || mainWindow.isDestroyed() || !bootGen.isCurrent(gen)) return;
      await mainWindow.loadURL(baseUrl);
      if (!bootGen.isCurrent(gen)) return;
      health.start(baseUrl, () => {
        reportUnhealthy(
          gen,
          createDshError(DshErrorCode.UNREACHABLE, 'unreachable'),
        );
      });
    } catch (err) {
      reportUnhealthy(gen, err);
    }
  } finally {
    bootInFlight = false;
  }
}

launcher.onExit(() => {
  reportUnhealthy(
    activeGen,
    createDshError(DshErrorCode.DSH_EXITED, 'dsh exited'),
  );
});

// createWindow:
mainWindow.on('minimize', () => {
  mainWindow.hide();
});

mainWindow.webContents.on('did-fail-load', (_e, _code, _desc, url, isMainFrame) => {
  if (!isMainFrame || isQuitting) return;
  if (typeof url === 'string' && url.startsWith('file:') && url.includes('loading.html')) {
    return;
  }
  if (!autoReloadUsed) {
    autoReloadUsed = true;
    mainWindow.reload();
    return;
  }
  reportUnhealthy(
    activeGen,
    createDshError(DshErrorCode.RENDERER_FAILED, 'load failed'),
  );
});

mainWindow.webContents.on('render-process-gone', () => {
  if (isQuitting) return;
  if (!autoReloadUsed) {
    autoReloadUsed = true;
    mainWindow.webContents.reload();
    return;
  }
  reportUnhealthy(
    activeGen,
    createDshError(DshErrorCode.RENDERER_FAILED, 'renderer gone'),
  );
});

// before-quit: health.stop(); then launcher.stop()...
```

- [ ] **Step 2: 跑全量单测**

Run: `npm test`  
Expected: 全部 PASS

- [ ] **Step 3: 更新 README「行为摘要」**

增加/调整：

- 运行中周期探测本地服务；不可达时错误页 + 重试
- 加载失败/渲染崩溃先自动重载一次，仍失败则错误页
- 关闭与**最小化**均隐藏到托盘
- 退出时停止本壳拉起的 dsh **进程组**（复用外部进程不杀）

- [ ] **Step 4: 手工冒烟**

1. `npm start` 正常进 UI  
2. 杀掉 dsh 后数秒内错误页，重试可恢复  
3. 最小化 → 托盘，「显示」可唤回  
4. owned 场景托盘退出后端口无残留（`lsof -i :18789`）

- [ ] **Step 5: Commit**

```bash
git add src/main.js README.md
git commit -m "$(cat <<'EOF'
feat: wire session health, reload, and minimize hide

Unify unhealthy paths through boot generation and user messages.
EOF
)"
```

---

## Spec coverage checklist

| Spec 项 | Task |
|---------|------|
| 外部掉线 → 错误页 + 重试 | Task 4 + 6 |
| Owned 进程组 TERM→KILL | Task 3 |
| did-fail-load / render-process-gone → reload×1 → 错误页 | Task 6 |
| 启动诊断分级文案 | Task 1 + 2 + 3 + 6 |
| 等待中 exit 不闪两次 | Task 5 + 6 |
| 最小化 hide | Task 6 |
| 单测覆盖 health/launcher/diagnose | Task 2–5 |
| README 行为摘要 | Task 6 |
| 非目标（指纹/打包/E2E） | 未列入任务 |

---

## 风险备注（实现时）

- `detached: true` + `stdio: 'inherit'` 若进程组无效：`killTree` 回退 `child.kill`，README 可记「尽力清理」。
- `did-fail-load` 可能打在 loading 页：必须用 `file:` + `loading.html` 忽略，避免死循环。
