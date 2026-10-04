# 开发约定

## 对话

- 回答短、直接，用中文。
- 提交说明、issue、PR 评论和代码里不用表情符号，也不用客套话。
- 无法避免的术语先定义再用。
- 非显然的设计按这个顺序写：问题，具体例子或短跟踪，然后方案。说明方案为什么必要。
- 用户提问时先回答，再改代码或跑实现命令。
- 回应用户的反馈或分析时，先明确同意或不同意，再写改了什么。

## 代码

- 大范围修改、编辑没完整看过的文件、以及调查或审计时，先读完整文件。不要靠搜索片段做大改。
- 不要用 `any`，除非确实没有别的写法。
- 只有一个调用点的单行辅助函数写在调用处。
- 外部 API 的类型去 `node_modules` 里核对，不要猜。
- 相对导入带 `.ts` 扩展名，并遵守 `verbatimModuleSyntax`。类型用 `import type`。
- 不要新加动态 `import()`，除非这条启动路径必须避免加载另一条。`packages/coding-agent/src/cli.ts` 在 `serve` 时才加载 host，属于这种例外。
- 类型错误来自过时依赖时，升级依赖，不要为了消错误删功能或降级实现。
- 删除看起来是有意留下的功能或代码之前，先问用户。
- 用户没要求时，不保留旧入口、旧数据格式或兼容别名。
- 外部行为和参照设计以读到的源码为准，不凭记忆补。

## Harness

目标是优秀、可扩展、能长期继续长的 harness。今天的 `AgentHarness`、`AgentLane`、四个编码工具和 Seatbelt 是当前实现，不是设计上限。

写新的对象或执行路径之前，先读这两处已经存在的设计：

- Pi 的 `packages/durable/docs/spec.md`：Conversation、Task、Document。工具调用走同一条管线。codemode 在 QuickJS 里跑模型写的脚本，嵌套工具调用回到这条管线，模型只收到脚本的输出和返回值。`store` / `load` 写在会话分支上。
- DeepSeek Harness 的 `packages/core` 和 `packages/ptc-runtime`：Agent 句柄和循环驱动分开。工具执行只有 `ctx.tools` 这一条受守卫的管线。PTC 的服务定义是跑一段程序并交回打印内容和返回值；Seatbelt、bwrap、Landlock 是沙箱 provider。插件依赖服务定义，不依赖某个具体 provider。

新能力接在这些对象和管线上。换掉一层时不重写其余部分。替换现有实现和它的调用方，不并列留下第二套核心对象。

## 当前分层

依赖只向下。改依赖时同时改 `test/package-boundaries.test.ts`：

- `@amazme/protocol` 只依赖 TypeBox。根入口不导入 Node，也不导出业务对象。
- `@amazme/client` 和 `@amazme/server` 只依赖 protocol。根入口不导入 Node、Durable 或 runtime-service。Unix socket 只在各自的 `/unix`。
- `@amazme/mcp` 不依赖其他 AmazMe 包。
- `@amazme/agent` 不依赖 `@amazme/durable`。Durable 调用 agent 已有的 `walkBefore`、`walkAfter`、`walkTransform`、`walkYield`，不另建 hook 遍历。
- `@amazme/runtime-service` 的契约和 client 入口不加载 Durable、server 或 Node。server 入口不加载 Node 和 JSONL 锁。

`AgentHarness` 与 `AgentLane` 在 `durable`。lane 的方法、快照和所有权在 `runtime-service`。`server` 只路由不透明调用。编码工具和 `amazme serve` 在 `coding-agent`。

## 命令

改完源码后跑 `npm run check:core`。它执行 `tsc -b`，并检查除 `coding-agent` 以外各包测试和根目录 `test/` 的类型，不跑测试。只改 `durable` 或 `runtime-service` 时，`npm run check:durable` 即可：同样先 `tsc -b`，再检查这两个包和根目录 `test/` 的测试类型。包内 `npm run check` 只有 `protocol`、`client`、`server`、`durable`、`runtime-service`。`coding-agent` 没有这个脚本，源码类型靠 `tsc -b`。

不要主动跑 `npm run build` 或完整 `npm test`。创建或修改了测试文件时，跑那个文件并改到通过：

```bash
node --import tsx --test packages/<pkg>/test/<file>.test.ts
```

模型测试用 faux provider，不调用真实供应商，也不使用密钥。Unix socket 测试需要本机监听权限；沙箱里的 `listen EPERM` 是环境限制，换允许监听的环境再跑。

临时脚本写到 `/tmp`，跑完删掉。不要把多行脚本嵌进 `bash -c`。

## 依赖

- 直接外部依赖钉死精确版本。把依赖和 lockfile 的改动当成要审查的代码。
- 本地安装用 `npm install --ignore-scripts`。没有用户要求时不跑安装生命周期脚本。
- 只有依赖元数据变化时，用 `npm install --package-lock-only --ignore-scripts` 更新 lockfile。用户没要求就不要提交 lockfile。

## Git

这个目录里可能同时有多个会话，各自改不同文件。动到自己改动之外的未暂存、已暂存或未跟踪文件，会盖掉其他会话的工作。

提交：

- 只有用户要求时才提交。
- 只提交本会话改过的文件。用明确路径 `git add <path>`，不要 `git add -A` 或 `git add .`。
- 提交前看 `git status`，确认暂存的只有这些文件。
- 说明格式：`{feat,fix,docs}[(包名)]: <说明>`。包名用目录名，多个包用逗号连接。说明用中文，写为什么。

不要运行：`git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git add -A`、`git add .`、`git commit --no-verify`。不要 force push。

变基冲突只处理自己改过的文件。冲突在没改过的文件里时，停下来问用户。

## 用户覆盖

用户的指示和本文冲突时，先问清楚再覆盖。确认之后再执行。
