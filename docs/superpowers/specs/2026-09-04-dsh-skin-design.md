# dsh-skin 设计说明

日期：2026-09-04  
状态：待用户确认后进入实现计划

## 目标

为本地已安装的 DeepSeek Harness（`dsh`）提供一个 macOS 桌面壳：用原生窗口内的 WebView 加载 `dsh web` 的本地地址，并支持启动、托盘显隐、退出时关闭 dsh。

成功标准：

- 打开 App 即拉起 `dsh web`（若尚未运行），窗口内直接显示 Web UI
- 关闭窗口不退出 App，隐藏到菜单栏；可从托盘或 Dock 唤回
- 从托盘选择退出时，干净停止 dsh 子进程再退出 Electron
- 不修改 dsh 本体与 `~/.dsh` 数据

## 非目标（首版不做）

- 自定义聊天/控制台 UI（窗口内容就是 WebView 加载的本地页）
- 打包内置 dsh、自动安装 dsh
- 多 profile / 皮肤切换 / 设置页
- Windows / Linux
- 自动更新

## 形态与技术选型

- **形态**：桌面窗口 App（方案 A）
- **切换**：窗口 ↔ 菜单栏托盘（方案 A）
- **关闭按钮**：隐藏到托盘，dsh 继续跑；真正退出从托盘菜单（方案 B）
- **技术**：Electron（便于 spawn 本机 Node/`dsh`、BrowserWindow、Tray）

## 架构

```
┌─────────────────────────────────────┐
│  dsh-skin（Electron 主进程）          │
│  - 解析 dsh 可执行路径                 │
│  - spawn / 监控 / 停止 dsh            │
│  - Tray：显示窗口 / 退出               │
│  - close → hide；quit → kill dsh     │
└──────────────┬──────────────────────┘
               │ HTTP 就绪后
               ▼
┌─────────────────────────────────────┐
│  BrowserWindow（WebView）            │
│  加载 http://127.0.0.1:<port>        │
│  --no-open，不弹系统浏览器             │
└─────────────────────────────────────┘
```

边界：

- 壳只负责进程生命周期与窗口/托盘
- UI 内容完全来自 dsh web，不做二次封装页面（除 loading/错误占位）

## 启停与托盘行为

### 启动

1. App 启动 → 主进程解析本机 `dsh`（`PATH`，并回退常见 nvm 路径）
2. 若目标端口已有服务在听，则直接复用（视为已有 dsh），不再重复 spawn
3. 否则 spawn：`dsh web --no-open --port <port>`
4. 轮询 `http://127.0.0.1:<port>` 直至就绪（超时则报错）
5. `BrowserWindow.loadURL` 加载该地址
6. 等待期间窗口显示 `loading.html`

默认端口：`18789`；可用环境变量 `DSH_SKIN_PORT` 覆盖。

### 切换（托盘）

- 托盘图标点击 / 菜单「显示」→ `show` + `focus` 窗口
- 窗口点关闭或最小化 → `hide`，不杀进程
- macOS Dock 图标点击 → 唤回窗口

### 退出

- 托盘「退出」→ 若本 App 拉起了 dsh 子进程：SIGTERM，短等待后必要时 SIGKILL → 再 `app.quit()`
- 若启动时复用了已有端口服务（非本进程 spawn），退出时**不**杀该外部进程（避免误杀用户手动起的 dsh）

### 异常

- 找不到 `dsh` / spawn 失败 → 错误页 + 重试
- 子进程意外退出 → 错误页 + 一键重启
- 端口被非 HTTP 占用 → 明确错误提示

## 项目结构

```
dsh-skin/
  package.json
  src/
    main.js          # 主进程：dsh 生命周期、Tray、窗口
    preload.js       # 首版极简，可不暴露业务 API
    loading.html     # 启动中 / 错误与重试
  assets/
    tray-icon.png
    icon.icns        # 可后补
  docs/superpowers/specs/
    2026-09-04-dsh-skin-design.md
  README.md
```

依赖：`electron`（开发运行）；`electron-builder` 可后置，首版以 `electron .` / npm script 本地跑通为准。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| 端口 | `18789` | `DSH_SKIN_PORT` 可覆盖 |
| dsh 路径 | 自动探测 | 可选日后加 `DSH_BIN` |
| 平台 | macOS | 首版唯一目标 |

## 错误处理摘要

| 场景 | 行为 |
|------|------|
| dsh 未安装 | 错误页说明，提供重试（不自动安装） |
| 启动超时 | 停止等待，错误页 + 重试；清理失败子进程 |
| 窗口崩溃 | Electron 默认；可重新 loadURL |
| App 退出 | 仅终止本壳 spawn 的子进程 |

## 测试要点（手工）

1. 冷启动：无 dsh → App 拉起 → 窗口出现 Web UI
2. 关窗口 → 托盘仍在，浏览器访问同端口仍可用；托盘「显示」唤回
3. 托盘「退出」→ 进程与端口释放
4. 先手动 `dsh web --port 18789` 再开 App → 复用、不双开；退出 App 不杀手动 dsh
5. 拔掉/改名 dsh → 错误页可读、可重试

## 实现顺序建议

1. Electron 最小窗口 + loading
2. spawn dsh + 就绪探测 + loadURL
3. 托盘显隐与退出清理
4. 错误/重试与端口复用
5. README 与本地启动脚本
