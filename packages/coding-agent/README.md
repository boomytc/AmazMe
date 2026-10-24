# AmazMe

AmazMe 是操作本机环境的桌面 AI 助手，源自 Pi packages。Python 承担业务内核；本包保留 Node CLI、终端呈现及图片 helper。Web/Electron、TUI、CLI、RPC 和 Python SDK 连接同一 Host，不启动旧 TS Host 或 Durable 会话。

```bash
amazme
amazme --print 'Read README.md'
amazme web
amazme models
amazme auth login --provider openai-codex
amazme doctor
```

本地开发先准备 `backend/.venv`，运行 `backend/.venv/bin/python -m amazme_backend --help`。`AMAZME_PYTHON_BACKEND` 指定 Python 后端可执行文件；已有服务可用 `--python-url` 和 `--python-token` 连接。凭据由 Python 私有账号库保存，OAuth 沿用 Pi 的客户端 ID、回调和供应商身份。

会话、SQLite、审批、执行归属、稳定调用 ID 和代际隔离由 Python 管理。离开客户端释放 attachment；它不等于取消工作。取消已受理与进程退出分开核对，未知副作用不自动重放。

模型、原生 shell/文件/PTY、stdio MCP、Python 插件、Codemode、computer-use、SSH，以及项目、记忆、定时任务、工作流和产物共用 [现行契约](../../docs/python-backend-plan.md)。[SDK 与示例](docs/sdk.md) 使用真实 Python API。旧 TS API 与迁移前文档见 [历史说明](docs/history.md)。

```bash
npm run build --workspace @amazme/coding-agent
npm test --workspace @amazme/coding-agent
```

构建对 CLI 的模块闭包检查，拒绝旧 JS 业务运行时。CUA 原生驱动的固定构建配方及安装校验仍保留在 `plugins/computer-use`；产品驱动与分类逻辑属于 Python。

1.0.0 前仅本机构建、自用，不公证、不发布。MIT 许可证与上游来源归属保持原样。

本机 CLI 从启动目录选择对应的 Python 工作区；`--workspace NAME` 使用已登记名称。
`amazme workspaces list` 查看目录，`workspaces add NAME /absolute/path` 显式登记。
`--continue` 继续当前工作区最近的非归档会话；`--resume` 在 TUI 中选择，`--session ID` 指定会话。
回执未确认时保留原请求 ID，使用 `--session ID --request ID` 或 TUI 的 `/request ID` 查询，不会自动重发。
