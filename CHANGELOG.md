# Changelog

本文件只记录 2026-10-24 起的 Python 产品线。产品版本由根 package.json、各 workspace 和 backend/pyproject.toml 对齐；旧产品记录保留在 Git 历史。

## [Unreleased]

- 桌面启动自动准备所需客户端与 Python 后端；本机浏览器直接连接，无需手动配对。
- 关闭窗口可选择后台运行或退出，活动任务提示可记住选择；显式退出取消任务并等待资源回收。
- 清理旧内核、VM 实验和失效说明，统一产品版本及开发入口。

## [0.1.0] - 2026-10-24

- Python Host、会话 worker 和监督器拥有模型调用、SQLite、审批、取消及本机执行。
- Web/Electron、CLI/TUI、RPC 与 Python SDK 使用同一后端。
- 只接受新会话格式，不迁移旧 Durable 或 JSONL 会话。
