# 默认 Durable 交互运行时

默认交互 CLI 使用 `@amazme/durable`。一个进程持有模型运行时、Harness、SQLite 存储与 TUI，读取当前配置目录中的模型、凭据和设置。正式实现位于 `src/durable/`，编译模块随包发布，SDK 的 `main()` 与 CLI 使用同一个交互入口。

SDK 与 Durable 将现有 `httpIdleTimeoutMs` 同时用于 Models 的流空闲截止，`0` 关闭该截止；供应商 HTTP `timeoutMs` 仍独立。共享流边界负责结束不响应信号的等待，用户取消不重试，空闲超时沿现有重试策略处理。结束后迟到事件不能写入会话。

`--no-session` 将同一 Harness 的存储换成现有 MemoryStorage，不创建会话目录或锁；`--session-dir` 及对应环境变量、设置选择持久根目录，仍按真实工作目录分组并使用原有锁。`--name` 与焦点保存在同一会话文档，页脚消费该投影，续开时恢复；没有额外命名文件或内存执行器。

`node packages/coding-agent/dist/bundle/cli.js` 启动新会话，追加 `--continue` 打开当前工作目录的最近会话。存储路径为 `~/.amazme/agent/experimental/durable-sessions/<cwd-hash>/<session>/session.sqlite`；文件锁防止两个进程同时写入。崩溃遗留锁在 10 秒后失效，重开会等待锁恢复。

界面读取 `Conversation.viewState()`，流式内容、工具进度、输入队列、重试、压缩、模型及用量由 Durable 状态提供。每次子代理运行由调用它的工具监督，持久子会话归属父对话；取消整个父对话会停止其所属工作。当前焦点存入 `amazme.session.focus`，重开时恢复。

启动支持 `--provider`、`--model`（含 `:thinking` 后缀）、`--thinking`、`--api-key` 和 `--use-theme`。显式推理级别优先于后缀，随后按模型能力约束；新会话按模型设置、全局设置、默认级别依次取值。临时密钥要求显式 `--model`，只用于当前进程；主题覆盖同样不写入设置。

提示资源使用既有 DefaultResourceLoader：`--system-prompt`、可重复的 `--append-system-prompt`、`--skill`、`--no-skills` 及 `--no-context-files` 直接控制实际模型请求；系统文件、技能的项目优先级、包过滤及信任沿同一解析。提示扩展消费加载器的结果，没有独立目录缓存。空闲时 `/reload` 重读资源；有插件时沿原重载屏障一起处理，未选插件时不创建插件宿主。临时主题覆盖在重载和信任切换后保留，设置写入不包含该覆盖。

模板、技能命令和主题同样消费这一加载器：模板与技能正文通过共同展开函数，在当前分支提交或排队前展开；已选插件命令优先，同名内建命令保留。发现开关不屏蔽显式路径，`enableSkillCommands` 只控制补全。界面接收同一资源所有者的主题结果，资源筛选不能被目录回退绕过；主题文件的实际路径用于监听，关闭清理监听及迟到颜色回调。`--tui-mode` 或保存的设置选择既有 TuiMainScreen/TuiAltScreen，同一工具、状态与控制器继续使用。

`--continue` 先恢复焦点会话，再应用显式模型或推理覆盖；不覆盖其他分支，不提供覆盖时沿用持久值。已经准备并保存的请求保留自己的模型和推理参数，恢复后的下一次生成采用当前选择。非法模型在创建或锁定会话存储之前拒绝。

工具支持 `--tools` 白名单或 `+name`/`-name` 增减、`--no-tools`、`--no-builtin-tools` 和最后执行的 `--exclude-tools`。默认四个基础工具及 `subagent`；搜索和 PowerShell 工具已注册，可显式激活。选择作为名称或模式存入当前会话，恢复时保留；动态注册与加载继续遵守白名单和排除边界。非法列表在打开存储前拒绝，本地搜索沿用宿主的程序解析与安装机制，其他环境提供自己的程序。

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
| `/session` | 当前分支的消息数量与累计缓存重复计费统计，包含继承历史 |
| `/bug [description]` | 选择诊断、模型摘要或完整会话，再选择本地 ZIP 或上传；Esc 取消 |
| Ctrl+O | 展开工具结果和压缩摘要 |
| Ctrl+C、Ctrl+D | 退出；未完成执行在重开时恢复 |

| 文件 | 职责 |
| --- | --- |
| `interactive.ts` | CLI/SDK 交互入口及打开、运行、关闭 |
| `sessions.ts` | 工作目录会话选择、存储路径和文件锁 |
| `runtime.ts` | 模型运行时、Harness、环境和控制器 |
| `harness-setup.ts` | 共用设置、工具注册和初始模型选择 |
| `prompt.ts` | 工具、规则、AGENTS.md、技能及工作目录提示 |
| `subagent.ts`、`subagent-run.ts` | 同一子会话的创建、发现、继续与每次输入的精确取消 |
| `tui.ts` | TUI 呈现与键盘交互 |
| `conversation-view.ts` | TUI、Web、服务共享的会话视图和结果类型 |
| `session-surface.ts` | 会话导航、分叉、历史分页与焦点持久化 |
| `bug-report.ts` | 将当前分支与崩溃记录打包，按用户选择导出或上传 |

该目录只承载默认 TUI 及共享会话逻辑。常驻宿主服务在 `src/host/`；统一宿主、客户端及安装产物的交付要求见 `docs/product-improvements.md`。

`showCacheMissNotices` 开启时，TUI 从已加载历史重新计算显著缓存未命中提示；恢复、分页和压缩重绘沿用同一计算。`/session` 扫描当前分支的全部持久历史，统计不受界面分页限制。压缩、分支摘要和上下文重置会中断前后请求的缓存比较。

`/bug` 默认选择仅诊断和本地 ZIP，不附带对话正文。模型摘要会使用当前供应商凭据和 token；完整会话会附带消息、工具结果和已读取的文件内容。上传选项显示 Radius 网关地址及 Pi 开发者接收方，离线模式只能导出。上传失败保留崩溃记录，可重新选择 ZIP；成功交付只清除报告中包含且期间未变化的崩溃日志。交互运行时记录致命异常，下次启动提示使用 `/bug`。

`subagent` 使用统一的 `action: "run" | "list"`：run 提供 `task`，可用返回的 `conversationId` 继续空闲孩子的同一段历史；list 仅列出当前父对话创建的子代理，并用 `beforeConversationId` 分页。新孩子继承工具选择，不继承父对话历史，不能再次委派。父模型从工具正文收到孩子编号和答案，TUI/Web 沿用同一 `details.conversationId`。

子会话通过父对话的归属任务保持可追溯，每次调用使用普通 Durable 监督任务提交并等待结果；没有单独的后台代理执行器或目录状态。取消单次调用会停止承载其输入的运行，已经进入同一运行的 steer 一并取消；孩子内后来排队的 follow-up 和后续独立运行保留。取消整个父对话仍停止整个所属范围。重启复用持久任务和 requestId，取消恢复只查已有提交，绝不补发新输入。
