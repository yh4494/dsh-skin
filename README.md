# dsh-skin

macOS 桌面壳：用 Electron 窗口加载本机 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh web`）的本地 Web UI，支持托盘显隐与退出时清理子进程。

## 依赖

- **Node.js**（建议 LTS）
- **本机已安装 `dsh`**，且可在 shell 中执行，例如：

  ```bash
  npm i -g @deepseek-ai/dsh
  ```

  若 `dsh` 不在当前 `PATH` 中（常见于 nvm），壳会自动尝试 `~/.nvm/versions/node/*/bin/dsh`；也可通过 `DSH_BIN` 显式指定（见下文）。

## 安装与运行

```bash
npm install
npm start      # 启动 Electron 壳
npm test       # 运行单元测试
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `DSH_SKIN_PORT` | `18789` | `dsh web --port` 使用的端口；若该端口已有 HTTP 服务在监听，则直接复用，不再 spawn |
| `DSH_BIN` | 自动探测 | `dsh` 可执行文件的绝对路径；优先于 `PATH` / nvm 回退 |

示例：

```bash
DSH_SKIN_PORT=19000 DSH_BIN=/path/to/dsh npm start
```

## 行为摘要

- **启动**：解析 `dsh` → 检测端口是否已有服务 → 若无则 `dsh web --no-open --port <port>` → 等待 HTTP 就绪后窗口加载 `http://127.0.0.1:<port>`；等待期间显示 loading 页
- **健康探测**：运行中周期探测本地服务；不可达时显示错误页，可点击重试
- **加载失败 / 渲染崩溃**：先自动重载一次，仍失败则显示错误页
- **关窗 / 最小化**：关闭与**最小化**均隐藏到托盘，App 仍在菜单栏托盘运行，`dsh` 继续服务
- **唤回**：托盘「显示」或 Dock 图标点击可重新显示窗口
- **退出**：托盘「退出」时停止本壳拉起的 dsh **进程组**（SIGTERM→SIGKILL，尽力清理）；若启动时复用了已有端口上的外部 `dsh`，退出时 **不会** 误杀外部进程
- **错误**：找不到 `dsh`、spawn 失败、超时、进程退出或服务不可达等会显示分级文案错误页，可点击重试

## 平台

首版仅支持 **macOS**。不修改 `~/.dsh` 数据，不提供设置页。
