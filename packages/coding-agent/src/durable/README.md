# 默认 Durable 交互运行时

默认交互 CLI 使用 `@amazme/durable`。一个进程持有模型运行时、Harness、SQLite 存储与 TUI，读取当前配置目录中的模型、凭据和设置。正式实现位于 `src/durable/`，编译模块随包发布，SDK 的 `main()` 与 CLI 使用同一个交互入口。

`--no-session` 将同一 Harness 的存储换成现有 MemoryStorage，不创建会话目录或锁；`--session-dir` 及对应环境变量、设置选择持久根目录，仍按真实工作目录分组并使用原有锁。`--name` 与焦点保存在同一会话文档，页脚消费该投影，续开时恢复；没有额外命名文件或内存执行器。

`node packages/coding-agent/dist/bundle/cli.js` 启动新会话，追加 `--continue` 打开当前工作目录的最近会话。存储路径为 `~/.amazme/agent/experimental/durable-sessions/<cwd-hash>/<session>/session.sqlite`；文件锁防止两个进程同时写入。崩溃遗留锁在 10 秒后失效，重开会等待锁恢复。

## 三条会话路径

交互 TUI、print/RPC、宿主各写各的存储。下面是当前行为；表中标为「当前」的回写损失留到后续变更再修。

| 路径 | 磁盘位置 | 接受 | 拒绝或当前限制 |
| --- | --- | --- | --- |
| 交互 TUI | `~/.amazme/agent/experimental/durable-sessions/<cwd-hash>/<session>/session.sqlite`。不写 JSONL，也不走 handoff。 | `--continue`、`--resume`、单独的 `--no-session`（内存，不建目录）、`--session-dir`、`--name` | `--fork`、`--session`、`--session-id` 各自以状态 1 退出，提示改用 `/tree` 和 `/fork`，并说明这三个参数选择 print/RPC 的 JSONL 会话。此时不创建 durable 存储。`--no-session` 与 `--continue` 或 `--resume` 同用也以状态 1 退出。 |
| print / RPC | `<agentDir>/sessions/<编码后的 cwd>/*.jsonl`，由 `SessionManager` 读写。`--print`、非 TTY、`--mode json` 和 `--mode rpc` 都走这里。 | `--fork`、`--session`、`--session-id`、`--continue`、`--resume`、`--no-session` | 上面的交互拒绝不在这里生效。`--no-session` 使用内存会话，先于 `--continue`、`--resume`、`--session` 和 `--fork`。`--resume` 打开选择器。 |
| 宿主（web / gui 的 server worker） | 每个 worker 一份 durable：`<agentDir>/experimental/sessions/<id>/session.sqlite`，同目录有 `meta.json`。`--session-dir` 换的是这个目录，不是交互 TUI 的 durable 根。终端副本在 print/RPC 的 JSONL 目录：已有同 id 文件就覆盖该文件，否则写成 `<timestamp>_<id>.jsonl`。 | 空的 durable 转录，且该工作目录有同 id 终端 JSONL 时，从该文件 seed。`amazme client` 的用法文本包含 `--session-id <id>`；client 命令注册了该选项，与 `--continue`、`--resume` 互斥。这个 id 按已发现服务器的宿主会话列表匹配 `sessionId` 再 attach。列表里没有时：client TUI 在非 radius 且只有一个服务器时用该 id 创建宿主 Session；非 TUI 的 client 还要求同时带 prompt，否则报服务器里没有该会话。这不是 print/RPC 用来选择 JSONL 文件的 `--session-id`。 | `amazme web` 与 `amazme server` 的用法文本不列出 `--fork`、`--session`、`--session-id`，这两个命令的选项里也没有这三项；其余参数会报 `Unsupported options for web` 或 `Unsupported options for server`。seed 之后，每个已提交 revision 整文件替换同一 JSONL，不比较 mtime 或内容。回写先写同路径的 `.tmp-<pid>`，再 `rename`；写入失败或该临时文件残留时，终端仍读取原来的 `.jsonl`。 |

交互 TUI 的 durable 会话不会出现在 JSONL 列表里，所以 TUI 的 `--continue` 和 print/RPC 的 `--continue` 互相看不见。宿主会话会写 JSONL 副本，因此会出现在终端列表中。

当前回写（测试只记录现状）：seed 按 `getEntries()` 的文件顺序线性写入，不沿 `parentId`。一次 mirror 把活动视图收成单链，原文件里的分叉不再保留；不在活动叶上的消息仍按文件顺序留在链上。`model_change`、`thinking_level_change`、`label`、`session_info`、custom 消息、`branch_summary` 只计数，不进入 durable，回写后从终端文件消失。终端文件里的 `session_info` 不会被 seed 带上；只有调用方另传的显示名才会写成新的 `session_info`。线性会话里的 compaction 会变成 durable 的 `amazme.reset`（`head` 为自身）。mirror 只写活动视图，压缩点之前的消息从 JSONL 消失，摘要变成 `compactionSummary`，且 `tokensBefore` 写成 0；再投影回 durable 时这条摘要按 `message:compactionSummary` 计数后丢掉。因此 JSONL → durable → JSONL → durable 在含 compaction 时并不保持同一份转录。

界面读取 `Conversation.viewState()`，流式内容、工具进度、输入队列、重试、压缩、模型及用量由 Durable 状态提供。子任务由调用它的工具持有，取消主任务会取消其子任务。当前焦点存入 `amazme.session.focus`，重开时恢复。

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

该目录只承载默认 TUI 及共享会话逻辑。常驻宿主服务在 `src/host/`；统一宿主、客户端及安装产物的交付要求见 `docs/product-improvements.md`。
