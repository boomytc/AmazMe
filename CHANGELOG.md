# Changelog

本文件只记录 2026-10-24 起的 Python 产品线。产品版本由根 package.json、各 workspace 和 backend/pyproject.toml 对齐；旧产品记录保留在 Git 历史。

## [Unreleased]

- 跟进 Pi 的列表分页、Kitty 功能键、Shift+Enter、终端标题过滤与 Markdown 呈现修复；缩放图片优先选择较小编码。
- MCP OAuth 自动选择 CIMD 或 DCR 并保留已有注册；工具搜索优先完整名称，刷新 Terra 等模型与 OpenCode 协议端点。
- 桌面启动自动准备所需客户端与 Python 后端；本机浏览器直接连接，无需手动配对。
- 关闭窗口可选择后台运行或退出，活动任务提示可记住选择；显式退出取消任务并等待资源回收。
- 清理旧内核、VM 实验和失效说明，统一产品版本及开发入口。
- 跟进 Pi 的终端搜索、深层引用、图片裁剪和全屏选词修复。
- Gemini 工具 schema 保留字面数据并投影 const，刷新 Kimi K3.1 模型目录；助手消息记录每回合请求的推理等级。
- macOS 取消 shell 时先暂停已追踪进程，防止子进程退出后继续执行下一条命令。
- 移除评测包未使用的 autoevals 依赖。
- 跟进 QwenPaw 的会话删除隔离与工具参数展示预算，保留完整参数复制。
- 正常删除包含写锁和工作日志的会话目录，避免误报未知文件；补充真实浏览器的草稿与删除回归。

## [0.1.0] - 2026-10-24

- Python Host、会话 worker 和监督器拥有模型调用、SQLite、审批、取消及本机执行。
- Web/Electron、CLI/TUI、RPC 与 Python SDK 使用同一后端。
- 只接受新会话格式，不迁移旧 Durable 或 JSONL 会话。
