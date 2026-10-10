# AmazMe

**以插件扩展的编码代理，支持终端、Web 和桌面入口。**

给 AmazMe 一个工作目录和任务，它可以读取代码、修改文件、执行 Unix 命令，并通过持久会话、任务记录和工具结果继续工作。实现基于 [Pi 的 packages](https://github.com/earendil-works/pi)，以小内核、可选插件和可恢复执行为主要设计方向。

## 能做什么

- **处理代码任务**：文件读写、精确编辑、命令执行、代码搜索和图片输入；修改已有文件时检查读取版本，避免覆盖外部变更。
- **管理持续工作**：会话历史、分叉、上下文压缩、介入与排队、取消和任务视图；模型及工具选择跟随当前对话。
- **连接模型与工具**：供应商 API key、OAuth、兼容端点、MCP 和 Codemode，按需要选择可用工具。
- **使用多种客户端**：独立终端直接工作；宿主终端客户端、Web 与 Electron 桌面共享同一宿主的会话和实时状态。
- **修改自身扩展**：发现所选插件的源码和 API，修改后用 `/reload` 重建；候选构建失败时保留可用版本。

项目记忆、历史召回、文件检查点、自动化、完成验证和工作流通过可选插件提供。未选择的能力不注册其工具、后台工作或管理入口。

## 快速开始

### 1. 从本仓库构建

需要 Node.js **22.19 或更新版本**。在仓库根目录运行：

```bash
npm install --ignore-scripts
npm run build
```

首次构建需要联网获取模型目录数据。已有完整本地数据时，可以用 `npm run build:offline` 跳过刷新；该命令会先检查数据是否齐全。

### 2. 在项目目录启动

```bash
cd /path/to/your-project
node /path/to/AmazMe/packages/coding-agent/dist/bundle/cli.js
```

进入终端后，用 `/login` 连接供应商，再用 `/model` 选择模型。也可沿用已有的供应商环境变量，例如 `DEEPSEEK_API_KEY`。OAuth 客户端 ID、回调和供应商请求身份沿用 Pi。

给出一个具体任务，例如：

```text
梳理这个项目的启动入口，说明关键模块之间的关系。
定位配置读取问题，修正后使用已有检查验证。
读取这个页面的代码和截图，调整布局并核对实际效果。
```

### 3. 选择入口

下表用 `amazme` 表示产品命令。未链接本地包时，可用上面的 `node /path/to/AmazMe/.../cli.js` 启动命令替代它。

| 入口 | 调用 | 用途 |
| --- | --- | --- |
| 独立终端 | `amazme` | 直接使用原生终端与持久会话 |
| Web | `amazme web` | 打开打印的回环 URL，通过浏览器使用宿主 |
| 常驻宿主 | `amazme server` | 运行宿主，供客户端连接 |
| 宿主终端客户端 | `amazme client` | 连接同一宿主的会话与实时状态 |
| 诊断 | `amazme doctor` | 只读检查配置、凭据可用性和运行资源 |

例如，从源码构建产物启动 Web：

```bash
node /path/to/AmazMe/packages/coding-agent/dist/bundle/cli.js web
```

若希望直接使用 `amazme` 命令，可在构建后链接本地包：

```bash
npm link --workspace @amazme/coding-agent --ignore-scripts
```

Web 提供会话切换、模型与推理选择、工具结果、文件、终端和任务视图，以及已启用能力的管理面板。支持中文与英文、浅色与深色外观；页面关闭不等于取消宿主已经接纳的工作。

完整操作见 [快速开始](packages/coding-agent/docs/quickstart.md)、[使用指南](packages/coding-agent/docs/usage.md)和 [CLI 参考](packages/coding-agent/docs/cli.md)。

## 按需扩展

先选择适合任务的资源：提示模板复用输入，技能提供操作说明，原生插件贡献工具、命令、提示段、任务、钩子和服务。

原生插件使用 Chord facets 和同一个 Durable Harness，注册与资源释放跟随其所属生命周期。选择源码文件或插件包：

```bash
amazme -e /path/to/plugin
amazme web -e /path/to/plugin
```

仓库提供以下可选插件，包目录也随 coding-agent 发布：

| 插件 | 作用 |
| --- | --- |
| [history](packages/coding-agent/plugins/history/README.md) | 只读搜索和读取会话历史 |
| [memory](packages/coding-agent/plugins/memory/README.md) | 可阅读、可编辑的 Markdown 项目记忆 |
| [checkpoint](packages/coding-agent/plugins/checkpoint/README.md) | 文件检查点、恢复预览、备份与选择性恢复 |
| [automation](packages/coding-agent/plugins/automation/README.md) | 宿主定时任务、时区与逐次执行记录 |
| [verification](packages/coding-agent/plugins/verification/README.md) | 显式命令检查、独立回执与有限修正 |
| [workflows](packages/coding-agent/plugins/workflows/README.md) | 可复用分阶段任务、有界并发和持久暂停/恢复 |

例如，使用仓库中的项目记忆插件：

```bash
amazme -e /path/to/AmazMe/packages/coding-agent/plugins/memory
```

通过 `/plugins` 查看所选来源，修改原源码后，在任务结束或取消时运行 `/reload`。应用壳和内核修改需要构建与重启。自动化使用宿主的 `server` 角色，详见对应插件说明。

原生包通过 `chord.facets` 声明角色，API 为 `@amazme/coding-agent/plugin`。SDK 与 print/RPC 使用独立的扩展工厂契约，包资源声明沿用 `pi` 字段。开发前查看 [插件执行与重载](packages/coding-agent/docs/plugin-runtime.md)、[原生示例](packages/coding-agent/examples/plugins/)或 [SDK 扩展](packages/coding-agent/docs/extensions.md)。

## 配置与文档

项目配置在工作目录的 `.amazme`，用户配置在 `~/.amazme/agent`。模型、认证、工具和资源选择的具体格式以各专题文档为准。

| 主题 | 文档 |
| --- | --- |
| 模型、API key 与 OAuth | [模型配置](packages/coding-agent/docs/models.md)、[供应商认证](packages/coding-agent/docs/providers.md) |
| 会话、继续与分叉 | [会话管理](packages/coding-agent/docs/sessions.md) |
| 项目指令、设置与信任 | [配置](packages/coding-agent/docs/configuration.md)、[设置参考](packages/coding-agent/docs/settings.md)、[项目安全](packages/coding-agent/docs/security.md) |
| 技能与提示模板 | [技能](packages/coding-agent/docs/skills.md)、[提示模板](packages/coding-agent/docs/prompt-templates.md) |
| 外部工具与程序调用 | [MCP](packages/coding-agent/docs/mcp.md)、[Codemode](packages/coding-agent/docs/codemode.md) |
| 界面与快捷键 | [主题](packages/coding-agent/docs/themes.md)、[快捷键](packages/coding-agent/docs/keybindings.md) |
| 嵌入与自动控制 | [TypeScript SDK](packages/coding-agent/docs/sdk.md)、[RPC](packages/coding-agent/docs/rpc.md)、[JSON 事件](packages/coding-agent/docs/json.md) |
| 排查问题 | [只读诊断](packages/coding-agent/docs/diagnostics.md)、[环境变量](packages/coding-agent/docs/environment-variables.md) |

完整目录见 [产品文档](packages/coding-agent/docs/index.md)。

## 开发

依赖安装与模型数据准备后，可使用源码入口：

```bash
npm run dev:tui
npm run dev:web
npm run dev:desktop
```

`dev:web` 默认端口 4310。桌面开发命令先构建 Web、coding-agent 和 GUI，再通过 Electron 打开同一宿主页面。正式 GUI 从已安装依赖解析 CLI；桌面壳需要 Electron，宿主需要 Node.js 22.19+。详见 [桌面包](packages/gui/README.md)。

修改包后，先构建再运行该包的既有检查：

```bash
npm run build --workspace @amazme/coding-agent
npm test --workspace @amazme/coding-agent
```

工程检查使用 `npm run check:workspace` 和 `npm run test:engineering`，覆盖导入、运行依赖、依赖方向、浏览器入口、入口预算与实际产物安装。默认离线测试隔离供应商凭据；显式 `AMAZME_TEST_LIVE=1` 才允许真实供应商测试读取环境凭据。

### 编译运行目录

依赖包已有构建产物时，使用 **Bun 1.4 或更新版本**生成本机平台的完整发行目录：

```bash
npm run build:binary --workspace @amazme/coding-agent
npm run build:binary --workspace @amazme/coding-agent -- --bun /path/to/bun --out /path/to/new-release
```

默认输出为 `packages/coding-agent/binaries/<platform>-<arch>`，Unix 从其中的 `amazme` 启动，无需另装 Node 或 Bun。必须保留并分发整个目录，其中包含插件 API、构建器、已安装模块和界面资源；构建不覆盖已有输出目录。当前开发与实跑以 Unix 为主，Windows 复用已有实现，未实测。

### 包结构

包作用域为 `@amazme/*`，依赖只向下。

| 包 | 职责 |
| --- | --- |
| [coding-agent](packages/coding-agent) | 产品 CLI、原生终端、宿主与插件接线 |
| [ai](packages/ai) | 多供应商模型、认证与流式 API |
| [agent](packages/agent) | 代理循环 |
| [durable](packages/durable) | 持久对话、任务、工具执行与恢复 |
| [chord](packages/chord) | 服务、复制状态、RPC 与 facets 生命周期 |
| [mcp](packages/mcp) | MCP 客户端 |
| [codemode](packages/codemode) | 调用注入工具的 JavaScript 沙箱 |
| [env](packages/env) | SSH 远程执行环境与 Unix daemon |
| [tui](packages/tui) | 终端界面与编辑器 |
| [web](packages/web) | 网页文档、视图投影与渲染 |
| [gui](packages/gui) | 加载同一 Web 页面的 Electron 窗口 |
| [protocol](packages/protocol) | 远程会话帧协议 |
| [client](packages/client) / [server](packages/server) | 远程会话连接与服务 |
| [telemetry](packages/telemetry) | 供应商无关的遥测契约 |
| [evals](packages/evals) | 文档与宿主评测 |

## 来源与许可

AmazMe 基于 Pi 的 packages，保留其 MIT 许可证和原有版权归属。当前上游基线、已吸收提交及后续跟进方法见 [UPSTREAM.md](UPSTREAM.md)，许可证见 [LICENSE](LICENSE)。

产品名、命令及包作用域使用 AmazMe；OAuth 与供应商请求身份、部分模型目录服务和 SDK 会话分享地址沿用 Pi。自身版本检查读取当前 AmazMe 包的元数据，源码和编译运行目录按各自来源更新。
