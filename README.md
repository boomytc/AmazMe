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
