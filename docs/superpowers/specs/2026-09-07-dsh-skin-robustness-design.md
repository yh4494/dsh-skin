# dsh-skin 健壮性增强设计

日期：2026-09-07  
状态：已确认，待实现计划  
前置：[`2026-09-04-dsh-skin-design.md`](./2026-09-04-dsh-skin-design.md)（首版壳已落地）

## 目标

在不改变「壳只负责进程生命周期与窗口/托盘、UI 来自 dsh web」边界的前提下，补齐运行期韧性：外部服务掉线可感知、窗口故障可恢复、启动诊断可操作、owned 进程退出尽量不留端口占用。

成功标准：

- 外部停掉复用的 `dsh`（`owned=false`）后，短时间内进入错误页，且「重试」可再次 boot
- 本壳 spawn 的 owned `dsh` 在托盘退出后，进程树被清理，默认端口可再次被绑定
- `did-fail-load` / `render-process-gone` 不白屏：先静默重载一次，仍失败则同一错误页
- 启动失败文案可区分：找不到 dsh / spawn 失败 / 端口被占用但非 HTTP / 超时未就绪
- 等待就绪期间子进程退出时，用户只看到一次最终错误（不闪两次）
- 最小化窗口行为与首版设计一致：hide，不退出
- `npm test` 全绿；新增逻辑以纯模块单测为主

## 非目标

- 打包 `.app`/DMG、正式 Dock/托盘美术、自动更新
- 识别「端口上的服务是不是 dsh」的深度指纹
- 无限/指数退避自动重启（避免重启风暴）
- 设置页、多 profile、Windows / Linux
- 修改 dsh 本体或 `~/.dsh`
- 强制 Electron E2E / CI（可后置）

## 决策摘要

| 主题 | 选择 |
|------|------|
| 实现路径 | 壳层韧性层（SessionHealth + launcher/诊断增强），非最小补丁、非完整 Supervisor |
| 外部 dsh 掉线 | 立刻统一错误页 + 重试 |
| 窗口崩溃/加载失败 | 静默 `reload` 至多 1 次，仍失败再错误页 |
| Owned 进程清理 | 进程组/树：SIGTERM → 短等待 → SIGKILL |
| 端口诊断深度 | 够用分级（不做 dsh 指纹） |
| 健康探测 | 周期探测；连续失败达阈值再报错 |

## 架构

保持「可测纯逻辑 + `main.js` 胶水」：

```
bootDsh / retry
    │
    ▼
launcher.start ──► 分类错误（not_found / spawn / port_busy_non_http / timeout）
    │
    ▼
loadURL 成功 ──► SessionHealth.start(baseUrl)
    │                 │
    │                 ├─ 周期 isHttpReady
    │                 └─ 连续 N 次失败 → onUnhealthy(reason)
    │
窗口事件 ──► did-fail-load / render-process-gone
    │           └─ 静默 reload ≤1 → 仍失败 → onUnhealthy
    │
owned 子进程 exit ──► onUnhealthy（与健康轮询去重）
    │
onUnhealthy ──► stop health → showError(loading.html?error=…)
retry ──► stop health → bootDsh（既有 bootInFlight）

quit ──► stop health → launcher.stop（进程组 TERM→KILL）→ app.quit
```

原则：凡「壳认为会话不可用」均汇入同一 `onUnhealthy`；用世代号（generation）或等价标志，避免健康轮询与 `onExit`、boot 竞态重复刷错误页。

## 组件职责

### SessionHealth（新建，纯逻辑）

- **做什么**：`start(baseUrl)` / `stop()`；周期调用可注入的 `probe(url)`；连续失败达阈值后调用 `onUnhealthy(reason)`；`stop` 后不得再回调。
- **不做什么**：不操作 BrowserWindow、不 spawn、不写文件。
- **建议默认**（可注入以便测试）：间隔 `2500ms`；连续失败阈值 `3` 次。

### dsh-launcher（增强）

- Spawn owned 子进程时尽量进入独立进程组（macOS/Unix：`detached` + 负 PID / `process.kill(-pid, …)` 等与现有 Node/Electron 兼容的做法；实现计划中选定一种并测通）。
- `stop()`：对进程组 SIGTERM，宽限期后 SIGKILL；仅当 `owned===true`。
- 启动路径：在决定 spawn 或复用前，区分「HTTP 已就绪」「端口无监听」「有连接迹象但非 HTTP」等，抛出稳定、可映射到文案的错误类别（可用 `code` 字段或 Error 子类；计划中固定一种）。
- 不负责长期健康监控。

### http-ready（小扩展）

- 保留现有「任意完成的 HTTP 响应即 ready」。
- 增加供启动诊断使用的探测（例如连接被拒 vs 非 HTTP 协议），供 launcher 分类；不做应用层指纹。

### main.js（接线）

- boot 成功且 `loadURL` 完成后启动 SessionHealth。
- 订阅 `did-fail-load`、`render-process-gone`：自动 reload 计数器按「成功 load 后」重置；至多 1 次静默重载。
- `onUnhealthy` / launcher `onExit` / boot 失败：统一 `showError`；重试走既有 IPC + `bootInFlight`。
- 等待 `waitForHttp` 期间若已 `onUnhealthy`/`onExit`，boot 路径不得再覆盖为第二次无关错误（世代号或 `bootGeneration`）。
- 最小化：`minimize` → hide（与 close 一致），对齐首版设计。
- quit：先 `SessionHealth.stop()`，再 `launcher.stop()`，再退出。

### loading.html

- 继续用 query `error` 展示消息；文案由 main 侧映射为可读中文（可含简短排查提示，如检查 `dsh` 是否在 PATH / `DSH_BIN`）。
- 不新增业务页面或设置 UI。

## 错误类别与文案方向

| 类别 | 触发 | 用户向提示方向 |
|------|------|----------------|
| `not_found` | 解析不到 dsh | 未找到 `dsh`，请安装或设置 `DSH_BIN` |
| `spawn_failed` | spawn ENOENT/其它 | 启动 `dsh` 失败（附简短原因） |
| `port_busy_non_http` | 端口占用但非 HTTP | 端口被其它程序占用，更换 `DSH_SKIN_PORT` 或释放端口 |
| `timeout` | 等待 HTTP 就绪超时 | `dsh web` 未在时限内就绪 |
| `dsh_exited` | owned 子进程退出 | `dsh` 已退出 |
| `unreachable` | 健康轮询失败（含外部复用掉线） | 本地服务不可达 |
| `renderer_failed` | 重载后仍 load/崩溃失败 | 页面加载失败 |

具体中文字符串在实现时定稿；类别集合应稳定以便测试断言。

## 错误处理与去重

1. `showError` 前始终 `SessionHealth.stop()`。
2. 每次 `bootDsh` 开始递增 generation；过期回调忽略。
3. 同一 generation 内多次 `onUnhealthy`：**只处理第一次**，忽略后续。
4. 重试：`stop` health → `bootDsh`；成功后再 `start` health，并重置 reload 计数。

## 测试策略

- **SessionHealth**：达阈值才回调；`stop` 后无回调；`stop` 之后返回的 in-flight probe 结果必须忽略。
- **launcher**：stop 调用进程组 kill 钩子（依赖注入）；启动诊断返回正确类别；既有 reuse/owned 行为回归。
- **http-ready 扩展**：非 HTTP / 拒连等分类（可用假 server 或注入连接层）。
- **竞态 / generation**：在可测的编排辅助或回调计数下，模拟 wait 中途 exit，断言有效 `showError` 路径只触发一次（generation 逻辑若抽纯函数则单测；若仅在 `main.js` 则用最小可测封装，避免无测胶水）。
- 不强制本阶段 Electron 驱动 E2E。

## 文档

实现完成后：更新 README「行为摘要」中与健康监控、退出清理、最小化相关的描述；不在本设计阶段改 README。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 进程组在 Electron/`dsh` 下行为与预期不符 | 依赖注入 kill 策略；手工验证一轮；失败则退回「尽力杀子进程 + 文档说明」并记已知限制 |
| 健康轮询误报（单次抖动） | 连续失败阈值 ≥2 |
| 本地其它 HTTP 服务被当成 ready | 保持首版语义；本阶段不做指纹（非目标） |
| preload 在 dsh 页仍注入 | 面小；本阶段不改安全模型 |

## 实现顺序建议（供 writing-plans）

1. 错误类别与 http/launcher 启动诊断  
2. launcher 进程组 stop  
3. SessionHealth 模块 + 单测  
4. main 接线：health、窗口事件、generation 去重、minimize hide  
5. 文案与 README 行为摘要同步  
6. 手工验收清单（外部杀 dsh、崩溃重载、退出后端口释放）
