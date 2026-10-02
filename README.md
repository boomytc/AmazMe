# AmazMe

一个按 [Pi `ed8b3bc`](https://github.com/earendil-works/pi/tree/ed8b3bcc194c8263ec8bec3f337053ae73866da1) 的传统路径做成的 TypeScript monorepo。模型 I/O、内存里的 agent 循环、编码会话各管一层，依赖只向下。持久化运行时已按 [Pi `7fbbd5f` 的独立包边界](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/package.json) 拆成 `@amazme/durable`，直接依赖 AI 和 Telemetry，与内存 Agent 分别运行。其 lane、恢复与存储设计保持原有范围，没有采用 Pi 的 Conversation / Task / Chord 架构。

```text
@amazme/telemetry      被动诊断契约、空实现、进程内记录
@amazme/ai             Provider、认证、统一消息、流事件
@amazme/agent          内存里的 turn 循环
@amazme/durable        可崩溃恢复的 AgentHarness、存储契约与适配器
@amazme/coding-agent   JSONL 会话树、read/write/edit/bash、CLI
```

今天的 `amazme` 命令走内存循环加会话树，和 Pi CLI 一样。`AgentHarness` 是另一条运行时：`accept` 只落盘，`drive` 才推进；进程挂了以后，下一次 `drive` 从完整的操作状态接着做。

## 模型边界

`Models` 是模型查找和调用的能力接口，具体集合由 `createModels()` 返回，并用 `setProvider` 装配。认证顺序是请求里的 key、已存储的凭证、环境变量，最后是 provider 声明的 ambient。存过凭证之后，后面的来源不再作为退路。凭证存储和环境变量留在实现内部，不要求每个消费者自己持有。

根入口只导出契约、工厂和纯辅助函数。线协议与供应商从子路径导入：

```typescript
import { createModels } from "@amazme/ai";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { completionsProvider } from "@amazme/ai/providers/completions";
import { openaiProvider } from "@amazme/ai/providers/openai";
import { fauxProvider } from "@amazme/ai/providers/faux";
```

消息只有 `system`、`user`、`assistant`、`toolResult`。`transformMessages` 负责换供应商：收短 tool call id，拿掉目标模型看不见的图片。线协议放在 `api/`，供应商文件只登记目录、认证和地址。现在的线协议是 `openai-completions`，OpenAI 这家供应商指向它。测试用 faux provider。`createProvider` 可以把目录、认证、地址和 headers 与一个协议实现，或按 `model.api` 分派的实现表组合起来。

Chat Completions 请求带 `stream_options.include_usage`。最终消息写入服务端的 input、output 和 total token；费用按模型 `cost` 上「每 1,000,000 token 的美元」计算，缺了费率就记 0，不查价格目录。`thinkingLevel` 先按模型能力映射，不支持的级别在发请求前以错误终态结束。映射出的参数写入 `reasoning_effort`；调用方若再传协议选项 `reasoningEffort`，以该选项为准。暂时的限流、网络故障，以及 408 / 500 / 502 / 503 / 504，把消息标成 `retryable`。配额、账单、认证和参数错误不标，501 和 505 也不标。AI 只分类，不自动重发。中途失败或取消会留下已经收到的文本和工具调用，并只发布一次终态。

流式帧可以记下来。帧即使看起来完整，也只是恢复用的前缀，不是一次已经结算的响应。

## 内存循环

一次 turn 是一次模型响应加上它的工具结果。Agent 不持有 Models。每次模型调用都走构造时传入的 `streamFn(model, context, options)`，它可以同步返回事件流，也可以异步取得事件流。`models.streamSimple.bind(models)` 满足这个形状。认证和 Provider 装配留在调用方。未传 `telemetryContext` 时使用空实现；要和某次 Models 共享诊断上下文，由调用方把那个上下文传进来。Steering 在当前 assistant 回合之后进入。Follow-up 要等到这次 run 本来会停的时候。`stopReason === "length"` 的 tool call 不执行。工具可以并行跑完，写回 transcript 时仍按 assistant 里的源顺序。

## 持久化运行时

`@amazme/durable` 提供 `AgentHarness` 和 `AgentLane`。运行时依赖结构化的 `HarnessModels` 能力接口，只要求模型查找、流式调用与可选诊断上下文；`createModels()` 可直接使用。`HarnessTool`、`HarnessMessage` 属于 Durable 自己的契约，可由同一套工具和消息实现满足两个运行时各自的接口。更多使用方式见 [Durable README](packages/durable/README.md)。

存储只有三类东西：只写一次的 entry 树、可替换的 value 和只追加的 list、只追加的 usage。一次 commit 要么全部可见，要么全部没有。

一条 lane 同时最多一个操作。操作状态是一整份当前叶子，每次转移都整份替换。恢复时读这棵叶子，不回放日志。

- 模型请求在 `assistant_effect_pending` 里预留 response id 和 usage id，然后才发送。中途崩溃就用已经写下的帧合成一条 `aborted` 响应，不再次发送。
- 响应和摘要结算把 entry、usage、tip 与阶段转移或操作终态一起提交。未结算状态的预留 entry / usage ID 必须尚未被占用；不一致的状态直接报错。
- 工具先写 intent。`replay: "never"` 的工具不重跑，结果里带上最后一次 checkpoint。`replay: "safe"` 用存下来的参数再执行。
- 多个工具可以乱序完成，entry 仍按源顺序挂到树上。
- 结束时删掉操作自己的 value，留下不可变的 `pi.result`，其中保存所属 lane。结算后和重启后都只允许所属 lane 读取，缺少归属的结果属于无效数据。

Harness 依赖结构化的 `Storage` / `StorageView` 接口，后端不需要继承 `MemoryStorage`。`run` 串行持有写入通道，每次 `apply` 单独原子提交；它不是跨多个 `apply` 的事务，回调失败也不会撤销此前已提交的数据。`apply` 仅在所属回调未结束时有效。

核心入口和 `MemoryStorage` 不导入 Node 模块，ID 使用 Web Crypto；没有全局 `process` 时，模型认证使用传入的 `env` 或空环境。`JsonlStorage` 使用独立 Node 入口：

```typescript
import { AgentHarness, type Storage } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
import { createStorageConformance } from "@amazme/durable/testing";
```

`/testing` 提供独立于测试框架的共享存储契约检查；该测试入口使用 Node 断言。当前处于初始开发阶段，以现有包入口和存储契约为准，不保留旧入口别名或旧数据格式修补逻辑。

## 诊断边界

`@amazme/telemetry` 是没有运行时依赖的底层包，AI、Agent 和 Durable 只向下依赖它。`TelemetryContext.startSpan` 包住一次工作，`TelemetrySpan` 提供子 span、事件、属性与状态。父子关系通过参数显式传递，不使用 Node 的异步全局上下文。

默认使用空实现。`InMemoryTelemetryContext` 在进程内记录，并通过 `getSpans()` 返回独立快照；生产监控适配器可以实现相同接口。适配器应同步调用业务回调一次，保留其返回值和拒绝原因，记录方法同步且不抛错；结束后的记录调用无效。未显式设置状态时，成功记为 `ok`，回调失败记为 `error`；显式状态以最后一次有效设置为准。`@amazme/telemetry/testing` 提供共享契约检查，仅测试入口依赖 Node。

```typescript
import { InMemoryTelemetryContext } from "@amazme/telemetry";
import { createModels } from "@amazme/ai";

const telemetryContext = new InMemoryTelemetryContext();
const models = createModels({ telemetryContext });
// Agent 只使用显式传入的 telemetryContext。要让模型请求挂在同一次记录下，调用方把上下文一并传入。
// AgentHarness 未单独提供时，仍使用 models.telemetryContext。
// 一次请求的 StreamOptions.telemetryContext 仍可覆盖 Models 的默认上下文。
// const agent = new Agent({ model, streamFn: models.streamSimple.bind(models), telemetryContext });
```

内置记录包括 Agent run、Harness drive、模型请求和实际工具执行；恢复和重试等待记为事件。工具收到的 `ToolContext.telemetryContext` 和 Provider 收到的 `StreamOptions.telemetryContext` 可继续创建子 span。默认属性只包含模型、工具与操作标识、结束原因和 token 数，不自动收集提示词、密钥、工具参数、输出或异常文本。

运行时通过被动 `startSpan` 边界调用适配器：即使适配器抛错、延迟或重复调用回调、返回错误结果，业务仍只执行一次，不等待导出结束。流式增量即时转发；内存实现会在发布请求终态前结束 span。诊断上下文不写入 transcript、存储或操作状态，重启恢复继续依赖原有持久化数据。内存实现不会自动清理记录，适合测试和单次运行检查；长时间运行应使用自行管理保留策略的适配器。

## 编码会话

会话文件是只追加的 JSONL 树，头部版本号是 3。它包含 `id`、`parentId`、`select`、`compaction`，文件格式与 Pi session 不兼容。`select` 把 tip 挪到旧节点。Compaction 插入摘要，把要保留的尾巴复制到摘要下面，并补上被切开的工具调用和工具结果。旧 entry 还在文件里，之后的模型请求不再看见摘要之前的内容。

内置工具是 `read`、`write`、`edit`、`bash`。`read` 可以重放，`write`、`edit` 和 `bash` 不行。

## 命令

```bash
npm install
npm test
npm run build
npm run check:durable
npx tsx packages/coding-agent/src/cli.ts "hello"
```

OpenAI：

```bash
npx tsx packages/coding-agent/src/cli.ts --provider openai --model gpt-4o-mini "你好"
```

这是同一套分层的独立实现，不是 Pi 仓库的拷贝。对齐范围是传统 Agent 这一路：没有 TUI、没有四十多个供应商、没有 Chord。`AgentHarness` 不支持 deferred 和摘要崩溃重试。`convertToLlm`、`transformContext`、工具前后 hook 和 `continue()` 也不在这里。
