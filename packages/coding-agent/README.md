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

`/model` 选择模型；`/tree` 查看历史，`/fork` 分叉，`/older` 加载更早记录，`/compact` 压缩当前上下文，`/tasks` 查看任务，`/mcp` 管理 MCP。模型、推理强度与工具选择属于当前对话，其他分叉保留各自配置。

工具可用名称白名单或仅由 `+name`／`-name` 组成的增减列表选择。文件覆盖和编辑检查先前读取的版本；外部变更时需要重新读取。工具结果、实际修改差异和所属任务保存在会话中，重开后可继续查看。

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
