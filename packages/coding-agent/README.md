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

模型、原生 shell/文件/PTY、stdio MCP、Python 插件、Codemode、SSH，以及项目、记忆、定时任务、工作流和产物共用 [现行契约](../../docs/python-backend-plan.md)。[RPC 入口](docs/rpc.md) 与 [Python SDK 示例](../../backend/docs/sdk.md) 使用真实 Python API。旧 TS API 与迁移前文档只保留在 Git 历史。

```bash
npm run build --workspace @amazme/coding-agent
```

构建对 CLI 的模块闭包检查，拒绝旧 JS 业务运行时。开发按 `confident-development-conventions` 做有限验收，临时验证资产完成即清理。

1.0.0 前仅本机构建、自用，不公证、不发布。MIT 许可证与上游来源归属保持原样。

本机 CLI 从启动目录选择对应的 Python 工作区；`--workspace NAME` 使用已登记名称。
`amazme workspaces list` 查看目录，`workspaces add NAME /absolute/path` 显式登记。
`--continue` 继续当前工作区最近的非归档会话；`--resume` 在 TUI 中选择，`--session ID` 指定会话。
回执未确认时保留原请求 ID，使用 `--session ID --request ID` 或 TUI 的 `/request ID` 查询，不会自动重发。

上下文文件、技能和提示词模板由 Python 按 Pi 的目录规则加载。
使用 `--skill PATH` / `--prompt-template PATH` 添加资源，`--no-context-files` / `--no-skills` / `--no-prompt-templates` 禁用默认发现。
输入 `/skill:名称 参数` 或 `/模板名称 参数`；TUI 用 `/skills`、`/prompts`、`/context` 查看资源，CLI 用 `amazme resources --session ID`。

`--thinking off|minimal|low|medium|high|xhigh|max` 选择下一回合推理等级，TUI 中用 `/thinking LEVEL` 修改后续回合。
Python 按 Pi 模型能力表调整不支持的等级；重试同一请求仍沿用原回合配置。

本机 `--no-session` 使用临时会话，退出时关闭其拥有的后端并清除已结算历史。
若副作用或退出仍未确认，会保留恢复记录并输出路径；原账号库和工作区不会被删除。

`amazme -e /absolute/tool.py` 为选中的 Python 会话加载 `setup(api)` 插件。
原会话重试查询同一登记，未知加载不会重新导入；更新代码使用原插件重载入口。
`--no-extensions` 禁用未显式指定的插件工具；RPC 下显式加载还需 `--session ID`。
`amazme web` 输出包含宿主、会话和工作区的窗口链接，不在链接中放置令牌。

`--session-dir DIR` 在 `DIR/python-host` 保存独立历史，使用原账号库及锁，避免复制刷新凭据；不能与临时会话或外部 Host 混用。
`--theme PATH` 加载显式主题，`--use-theme NAME` 选择，`--no-themes` 禁用默认用户主题发现，仍保留显式主题及内置主题。

`--model provider/id` 为本次会话选择模型；`--models 'provider/*:high,other/model'` 设置候选顺序。
TUI 用 `/model provider/id` 选择、`/model next` 按候选循环；模型和推理选项随原请求固定，重试不读取另一窗口的新选择。

无界面审批先用 `--session ID --request ID` 查询，再用 `--decision 批准 --request ID --approval-id ID` 指向显示的原提案。
重试保留这些编号；已结算提案只查询，不能自动批准同一请求的下一项工具。待审批退出码为 2。

`--offline` 仅跳过版本检查；模型目录默认使用包内快照，供应商调用仍按配置联网。
`--verbose` 显示 profile、构建和代际，不显示令牌。旧文件导出参数改用 `export --output PATH`；旧 TS 项目资源信任选项不再接纳，Python 插件只按显式登记加载。
