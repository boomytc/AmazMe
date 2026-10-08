# 默认 Durable 交互运行时

默认交互 CLI 使用 `@amazme/durable`。一个进程持有模型运行时、Harness、SQLite 存储与 TUI，读取当前配置目录中的模型、凭据和设置。正式实现位于 `src/durable/`，编译模块随包发布，SDK 的 `main()` 与 CLI 使用同一个交互入口。

`node packages/coding-agent/dist/bundle/cli.js` 启动新会话，追加 `--continue` 打开当前工作目录的最近会话。存储路径为 `~/.amazme/agent/experimental/durable-sessions/<cwd-hash>/<session>/session.sqlite`；文件锁防止两个进程同时写入。崩溃遗留锁在 10 秒后失效，重开会等待锁恢复。

界面读取 `Conversation.viewState()`，流式内容、工具进度、输入队列、重试、压缩、模型及用量由 Durable 状态提供。子任务由调用它的工具持有，取消主任务会取消其子任务。当前焦点存入 `amazme.session.focus`，重开时恢复。

| 操作 | 行为 |
| --- | --- |
| 提交 | 空闲时运行，忙碌时转向 |
| follow-up 快捷键 | 排队追加输入 |
| Esc | 取消当前会话中的执行或手动压缩 |
| `/model`、模型快捷键 | 选择当前会话的模型 |
| Shift+Tab | 切换推理级别 |
| `/compact [instructions]` | 压缩较早上下文；过小时报告无需压缩 |
| `/tree`、`/agents` | 切换会话，或返回更早的用户输入；可选择分支摘要 |
| `/fork` | 从当前会话最新记录创建分支并聚焦 |
| `/older` | 分页读取持久历史 |
| `/tasks` | 显示或隐藏当前任务图 |
| Ctrl+O | 展开工具结果和压缩摘要 |
| Ctrl+C、Ctrl+D | 退出；未完成执行在重开时恢复 |

| 文件 | 职责 |
| --- | --- |
| `interactive.ts` | CLI/SDK 交互入口及打开、运行、关闭 |
| `sessions.ts` | 工作目录会话选择、存储路径和文件锁 |
| `runtime.ts` | 模型运行时、Harness、环境和控制器 |
| `harness-setup.ts` | 共用设置、工具注册和初始模型选择 |
| `prompt.ts` | 工具、规则、AGENTS.md、技能及工作目录提示 |
| `subagent.ts` | 由工具调用持有的子任务 |
| `tui.ts` | TUI 呈现与键盘交互 |
| `conversation-view.ts` | TUI、Web、服务共享的会话视图和结果类型 |
| `session-surface.ts` | 会话导航、分叉、历史分页与焦点持久化 |

该目录只承载默认 TUI 及共享会话逻辑。常驻宿主服务在 `src/experimental/`；统一宿主、客户端及安装产物的交付要求见 `docs/product-improvements.md`。
