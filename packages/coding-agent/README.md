# AmazMe

AmazMe 是可扩展的编码代理，提供文件读写、Unix 命令、会话分叉与恢复、工具调用和插件重载。实现基于 [Pi 的 packages](https://github.com/earendil-works/pi)，产品命令为 `amazme`，包作用域为 `@amazme/*`。

## 运行

已安装完整运行依赖的 npm 包使用 Node.js 22.19 或更新版本：

```bash
amazme
amazme web
amazme server
amazme client
```

`web` 在回环地址提供网页，终端和网页连接同一宿主状态。编译运行时发布目录还可直接运行其中的 `amazme`，无需另装 Node 或 Bun；必须保留完整目录中的模块和资源。

项目配置在工作目录的 `.amazme`，用户配置在 `~/.amazme/agent`。供应商密钥可来自环境变量或 `models.json`，已有 OAuth 凭据来自同一认证存储。OAuth 的客户端 ID、回调和供应商请求身份沿用 Pi，不随产品名称改写。查看 [模型配置](docs/models.md)、[环境变量](docs/environment-variables.md)及 [CLI](docs/cli.md)。

在终端运行 `amazme auth login --provider openai-codex` 完成 OAuth，或 `amazme auth login --provider deepseek --method api-key` 输入密钥。`amazme auth logout --provider <provider>` 删除已保存的凭据，环境变量仍可使用。参见 [供应商认证](docs/providers.md)。

默认原生终端内也可使用 `/login [provider]` 与 `/logout [provider]`，登录后通过 `/model` 选择模型。输入的密钥保持隐藏，Esc 取消登录。

宿主终端客户端使用相同命令；Web/桌面从“设置 → 模型与连接 → 供应商账号”选择供应商和操作。Web 关闭弹窗保留进行中的登录，可重新打开继续；“取消登录”结束流程。

## 小内核与可选插件

默认 CLI、宿主与 Web 使用 Chord facets 和同一个 Durable Harness。插件可以贡献工具、命令、提示段、任务、钩子及服务，资源随其所属生命周期释放。项目记忆、历史召回、文件检查点、自动化、完成验证及工作流都按需选择，未启用时不运行其后台工作。

原生插件入口及 API：

- [插件执行与重载](docs/plugin-runtime.md)：`@amazme/coding-agent/plugin`，使用 `defineFacet`，注册由 `env.own()` 清理。
- [插件包示例](examples/plugins/)：宿主与客户端角色保持独立。
- [包管理](docs/packages.md)：安装位置、来源与项目选择。

从已安装产品的 `plugins/` 选择所需包，或提供自己的源码：

```bash
amazme -e /path/to/plugin
amazme web -e /path/to/plugin
```

修改原插件源码后，在任务空闲时运行 `/reload`。候选构建失败会保留可用版本；修复源码后可重试。应用壳及核心源码修改需要构建与重启。当前宿主会向模型提供已选插件的 manifest 位置，源码映射可定位原文件；默认终端直接加载源码时提供其位置。

[SDK 扩展](docs/extensions.md) 使用 `ExtensionAPI` 工厂，适用于 SDK 与 print/RPC 路径。它们与默认入口的原生 facets 是不同契约，选择对应文档和示例。

## 会话与工具

### 存储与恢复边界

| 路径 | 存储 | 选择与恢复 | JSONL 互通 |
| --- | --- | --- | --- |
| 默认原生交互 TUI | Durable SQLite；`--no-session` 使用内存 | `--continue` / `--resume` 恢复工作目录会话，界面内 `/tree` / `/fork` 导航 | 不直接写 JSONL，不迁移终端文件 |
| print / JSON / RPC / 兼容 SDK AgentSession | SessionManager JSONL | 使用该路径支持的 `--session`、`--session-id`、`--fork` 选择文件 | 保留 JSONL 树及条目格式 |
| 常驻宿主（Web、桌面、宿主终端客户端） | Durable SQLite | 宿主会话目录与同工作目录的终端会话列表 | 空转录且同 cwd、同 id 时可导入；提交后按序导出同一 JSONL |

原生交互拒绝 `--fork`、`--session`、`--session-id`，以及 `--no-session` 配 `--continue` 或 `--resume`，退出码为 1，不创建 durable 会话存储。这是兼容边界，不是自动迁移入口。

宿主只从首次捕获的原始内容导入 version 3 单链、普通 user / assistant / toolResult / system 消息，并先验证消息往返等价；不会通过读取触发旧文件迁移，坏行或未知元数据会禁用导入与镜像。分叉、终端专用元数据、扩展消息及摘要不能完整表示时，拒绝该次导入与覆盖镜像，保留终端原文件并报告原因；非空 durable 转录也不能覆盖不一致的既有终端文件。宿主生成的镜像在同一 durable 转录下保持导出 entry id 稳定，但不承诺保留原终端 entry id，摘要和树不属于全量往返等价合同。

镜像检测文件内容、身份与修改时间。发现外部追加、替换、截断、删除等冲突后，该 handoff 不再覆盖；Web/桌面显示持续警告，worker 同时记录 session 和目标路径。它不是双向同步，不会自动读回或合并终端新内容。首次创建使用不可覆盖的文件链接；既有文件最后检查与 rename 之间仍有非协作写入竞态，不承诺原子 compare-and-swap。正常失败会清理本次临时文件；硬崩溃仍可能遗留 `.tmp-<pid>-<uuid>`，列表不会将其当会话。

`/model` 选择模型，`/thinking` 选择推理强度，`/scoped_models` 配置模型菜单与轮换的候选范围；`/tree` 查看历史，`/fork` 分叉，`/older` 加载更早记录，`/compact` 压缩当前上下文，`/tasks` 查看任务，`/mcp` 管理 MCP。模型、推理强度与工具选择属于当前对话，其他分叉保留各自配置。

工具可用名称白名单或仅由 `+name`／`-name` 组成的增减列表选择。文件覆盖和编辑检查先前读取的版本；外部变更时需要重新读取。工具结果、实际修改差异和所属任务保存在会话中，重开后可继续查看。

`/changes` 查看本轮文件变更，`/limits` 配置回合预算，`/resume_run` 追加预算并继续，`/execution` 选择全局文件写入策略。Web/桌面通过独立设置导航和“会话工具 → 变更”操作同一运行控制；切换设置不释放当前会话。普通归档不停止任务，“停止任务并归档”才结束工作。恢复与隔离边界见[运行控制](docs/run-controls.md)。

- [使用与 Web](docs/usage.md)
- [MCP](docs/mcp.md)
- [Codemode](docs/codemode.md)
- [主题](docs/themes.md)、[技能](docs/skills.md)、[提示模板](docs/prompt-templates.md)
- [SDK](docs/sdk.md)、[RPC](docs/rpc.md)
- [诊断与命令参考](docs/cli.md)

## 开发与许可

仓库中先构建需要的依赖，再构建此包并运行既有检查：

```bash
npm run build --workspace @amazme/coding-agent
npm test --workspace @amazme/coding-agent
```

`build:binary` 使用 Bun 1.4 或更新版本生成本机平台的完整运行目录，复用当前锁文件与本地产物。命令支持 `--bun /path/to/bun` 和 `--out /path/to/new-release`，默认输出到 `binaries/<platform>-<arch>`。

MIT 许可证。上游版权及来源保持其原有归属。
