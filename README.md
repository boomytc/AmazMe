# AmazMe

AmazMe 是终端里的编码代理。它读取文件、运行命令、修改内容，并完成多步任务。

实现来自 [Pi](https://github.com/earendil-works/pi) 的 packages，包作用域和命令名是 AmazMe。许可证是 MIT，版权归 Mario Zechner。当前对齐的上游版本和后续跟进方法见 [UPSTREAM.md](UPSTREAM.md)。

需要 Node.js 22.19 或更新版本。

## 从本仓库运行

```bash
npm install --ignore-scripts
npm run build
node packages/coding-agent/dist/bundle/cli.js
```

`npm run build` 会先联网刷新模型目录，再按依赖从底向上编译。没有网络时用 `npm run build:offline`，它使用仓库里已有的模型数据。

构建完成后，在要工作的目录里启动：

```bash
node /path/to/AmazMe/packages/coding-agent/dist/bundle/cli.js
```

进入交互界面后用 `/login` 连接订阅或 API key，然后给出任务。

实验切片还能把同一个宿主交给浏览器（回环 WebSocket + 内置的网页客户端）：

```bash
AMAZME_EXPERIMENTAL=1 node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  ./packages/coding-agent/src/experimental/cli.ts web
```

界面语言（中／英）与外观（浅色／深色／跟随系统）在网页的设置面板里切换、存进 agent 的 `settings.json`，宿主按偏好
（没有偏好时按浏览器语言）在响应文档时就把静态外壳本地化，所以首帧不会闪英文。它会打印回环 URL、服务模式、
WebSocket 地址与 server id（`started` 表示这次启动自己起了宿主，`already running` 表示接上了已运行的宿主——
终端客户端与第二个网页从此共用同一个宿主的会话与实时状态），随后在浏览器里打开该 URL 即可看到会话名册、transcript、
实时状态与输入框：侧栏可以新建会话，输入框右侧的模型档可以切换当前会话的模型与推理档，助手回答按 markdown 排版呈现。
侧栏的 **Plugins**、**Skills**、**Automation** 与底部的 **Settings** 把主区切成管理面板：插件包与 `mcp.json` 里的 MCP 服务器、
宿主加载的技能（agent 目录下的可新建／编辑／删除／导入）、宿主自己按间隔运行的定时提示（存在 `schedules.json`，
关掉页面也照跑，回答落进对应会话），以及宿主发布字段目录的配置编辑（写入全局
`settings.json`，并让已连接的会话重读设置）。主区右侧的坞里是会话范围的四个面：工作目录文件、终端、会话清单
（含子代理的子会话）与实时任务图；命中审批策略的工具调用会在输入框上方等你通过或拒绝，每条已提交的助手回答
带一对评分控件（写进 agent 目录的 `feedback.json`），名册为空时主区给出一张首启引导卡片。名册里还会出现宿主工作目录下的终端会话（标 `terminal`）：附着即认领它，
宿主按同一 id 建档并从它的 JSONL 种入 transcript，之后把每个已提交的版本写回同一个文件，终端那边因此看到同一会话；
命令面板同样只有一份目录（宿主自己的命令、插件注册的命令、prompt 模板、技能，外加标 `terminal only` 的终端专属
命令），客户端执行不了的名字会被如实拒绝而不是当 prompt 发给模型。宿主断开后页面按退避自行重连并重新附着会话，
重连前后的状态一致。
细节见 [docs/usage.md](packages/coding-agent/docs/usage.md) 的 "Use the web client"。这一入口依赖
源码切片，尚未进入打包产物。

开发阶段，终端和网页不用先构建，直接跑源码；桌面窗口会先构建壳再打开：

```bash
npm run dev:tui      # 交互界面，源码入口 packages/coding-agent/src/cli.ts
npm run dev:web      # 网页客户端，源码入口 experimental/cli.ts web
npm run dev:desktop  # Electron 窗口，加载与 dev:web 同一个宿主
```

`dev:web`（[scripts/dev-web.mjs](scripts/dev-web.mjs)）默认端口 4310，打开它打印的 URL 即可，`--port`、`--server-id`、
`--session-dir` 与 `web` 命令一致；样式表按请求读盘，改完刷新页面就能看到，`index.html` 和 `page.ts` 在宿主启动时读取，
改完要重启这条命令。两个入口都经 `source-resolver.ts` 走 `packages/*/src`；`packages/ai/src/providers/data/` 的模型
目录数据不入库，`npm run build` 会先刷新它。

`dev:desktop` 先构建 `@amazme/gui`，再用 Electron 打开同一个宿主：窗口加载的就是上面这条 `web` 命令印出的回环页面，会话仍是那一套 durable。

项目配置在当前目录的 `.amazme`，用户配置在 `~/.amazme/agent`。命令名是 `amazme`。`@amazme/coding-agent` 的 bin 指向 `dist/bundle/cli.js`，所以要先构建，再从本仓库运行或做 `npm link`。

## 包

依赖只向下。

| 包 | 作用 |
| --- | --- |
| [@amazme/chord](packages/chord) | 服务、复制状态、RPC 和插件的组合运行时 |
| [@amazme/telemetry](packages/telemetry) | 与供应商无关的遥测契约 |
| [@amazme/tui](packages/tui) | 差分渲染的终端界面库 |
| [@amazme/codemode](packages/codemode) | 只能调用注入工具的 JavaScript 沙箱 |
| [@amazme/mcp](packages/mcp) | Model Context Protocol 客户端 |
| [@amazme/protocol](packages/protocol) | 远程会话的 CBOR 帧协议，依赖 chord |
| [@amazme/ai](packages/ai) | 多供应商模型 API，依赖 telemetry |
| [@amazme/agent](packages/agent) | 带工具调用的代理循环，依赖 ai |
| [@amazme/client](packages/client) | 远程会话客户端，依赖 chord 和 protocol |
| [@amazme/server](packages/server) | 远程会话服务端，依赖 chord 和 protocol |
| [@amazme/durable](packages/durable) | 持久的对话、任务和文档，依赖 chord 和 ai |
| [@amazme/env](packages/env) | 经 SSH 部署的远程执行环境，依赖 chord 和 durable |
| [@amazme/web](packages/web) | 回环网页客户端的文档与样式、启动契约与视图投影（实验切片） |
| [@amazme/gui](packages/gui) | Electron 窗口，加载同一套回环网页宿主（实验切片） |
| [@amazme/coding-agent](packages/coding-agent) | 交互式编码代理命令行 |
| [@amazme/evals](packages/evals) | 文档和宿主评测，依赖 ai 和 coding-agent |

扩展包在自己的 `package.json` 里用 `pi` 字段声明入口。加载器读的是这个字段。

## 开发

```bash
npm test --workspace @amazme/chord
npm test
```

`npm test` 会跑每个带测试脚本的包。单个包用上面的 `--workspace` 形式。

交互使用、打印模式、RPC 和 SDK 写在 [packages/coding-agent/docs](packages/coding-agent/docs/index.md)。这些文档里很多地方仍写成 Pi。

模型目录、版本检查和会话分享会访问 `pi.dev`。这是上游服务地址。
