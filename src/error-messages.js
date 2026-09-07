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
