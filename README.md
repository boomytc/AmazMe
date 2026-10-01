# AmazMe

一个按 [Pi `ed8b3bc`](https://github.com/earendil-works/pi/tree/ed8b3bcc194c8263ec8bec3f337053ae73866da1) 的传统路径做成的 TypeScript monorepo。模型 I/O、内存里的 agent 循环、编码会话各管一层，依赖只向下。`AgentHarness` 是额外的精简持久化操作机，与 CLI 的内存循环分别运行；它没有采用 [`pi-durable`](https://github.com/earendil-works/pi/blob/ed8b3bcc194c8263ec8bec3f337053ae73866da1/packages/durable/README.md) 的任务调度和 Chord 文档架构。

```text
@amazme/ai             Provider、认证、统一消息、流事件
@amazme/agent          内存里的 turn 循环，以及可崩溃恢复的 AgentHarness
@amazme/coding-agent   JSONL 会话树、read/write/edit/bash、CLI
```

今天的 `amazme` 命令走内存循环加会话树，和 Pi CLI 一样。`AgentHarness` 是另一条运行时：`accept` 只落盘，`drive` 才推进；进程挂了以后，下一次 `drive` 从完整的操作状态接着做。

## 模型边界

`Models` 按 `model.provider` 把请求交给对应的 Provider。认证顺序是请求里的 key、已存储的凭证、环境变量，最后是 provider 声明的 ambient。存过凭证之后，后面的来源不再作为退路。

消息只有 `system`、`user`、`assistant`、`toolResult`。`transformMessages` 负责换供应商：收短 tool call id，拿掉目标模型看不见的图片。线协议放在 `api/`，供应商文件只登记目录、认证和地址。现在的线协议是 `openai-completions`，OpenAI 这家供应商指向它。测试用 faux provider。

流式帧可以记下来。帧即使看起来完整，也只是恢复用的前缀，不是一次已经结算的响应。

## 内存循环

一次 turn 是一次模型响应加上它的工具结果。Steering 在当前 assistant 回合之后进入。Follow-up 要等到这次 run 本来会停的时候。`stopReason === "length"` 的 tool call 不执行。工具可以并行跑完，写回 transcript 时仍按 assistant 里的源顺序。

## 持久化 harness

存储只有三类东西：只写一次的 entry 树、可替换的 value 和只追加的 list、只追加的 usage。一次 commit 要么全部可见，要么全部没有。

一条 lane 同时最多一个操作。操作状态是一整份当前叶子，每次转移都整份替换。恢复时读这棵叶子，不回放日志。

- 模型请求在 `assistant_effect_pending` 里预留 response id 和 usage id，然后才发送。中途崩溃就用已经写下的帧合成一条 `aborted` 响应，不再次发送。
- 响应和摘要结算把 entry、usage、tip 与阶段转移或操作终态一起提交。旧版本留下的半结算数据，仅在条目、usage 和操作归属可核验时补齐状态，不重复写入或计费。
- 工具先写 intent。`replay: "never"` 的工具不重跑，结果里带上最后一次 checkpoint。`replay: "safe"` 用存下来的参数再执行。
- 多个工具可以乱序完成，entry 仍按源顺序挂到树上。
- 结束时删掉操作自己的 value，留下不可变的 `pi.result`，其中保存所属 lane。结算后和重启后都只允许所属 lane 读取；早期结果缺少 lane 时拒绝返回，避免猜测归属。

Memory 和 JSONL 走同一个存储接口。

## 编码会话

会话文件是只追加的 JSONL 树，头部版本号是 3。它包含 `id`、`parentId`、`select`、`compaction`，文件格式与 Pi session 不兼容。`select` 把 tip 挪到旧节点。Compaction 插入摘要，把要保留的尾巴复制到摘要下面，并补上被切开的工具调用和工具结果。旧 entry 还在文件里，之后的模型请求不再看见摘要之前的内容。

内置工具是 `read`、`write`、`edit`、`bash`。`read` 可以重放，`write`、`edit` 和 `bash` 不行。

## 命令

```bash
npm install
npm test
npm run build
npx tsx packages/coding-agent/src/cli.ts "hello"
```

OpenAI：

```bash
npx tsx packages/coding-agent/src/cli.ts --provider openai --model gpt-4o-mini "你好"
```

这是同一套分层的独立实现，不是 Pi 仓库的拷贝。对齐范围是传统 Agent 这一路：没有 TUI、没有四十多个供应商、没有 Chord。`AgentHarness` 不支持 deferred 和摘要崩溃重试。`convertToLlm`、`transformContext`、工具前后 hook 和 `continue()` 也不在这里。
