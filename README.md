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

`StreamOptions` 中的 `baseUrl` 和 `headers` 是各协议共用的请求配置。请求地址覆盖 Provider 默认地址，headers 按字段覆盖并保留其余默认字段。协议专用选项仍由 `ApiStreamOptions` 区分。`signal`、`apiKey`、`telemetryContext` 不会写入 JSON 请求体。

`StreamOptions.maxTokens` 是这一次生成的输出 token 上限，包含协议会计入的思考 token，不再另加一份思考预算。它会传到 `stream`、`streamSimple`、Provider 和 Models。Agent 上的可选 `maxTokens` 只转发给注入的 `streamFn`，Agent 仍然不持有 Models，也没有通用的请求改写 hook。省略时使用模型声明的输出上限；显式值仍受该上限和剩余上下文约束。放不下时不会发送 0、负数或 NaN，也不会删消息来凑预算，而是以不可重试的 `overflow` 终态结束。参数非法和上下文放不下是两种结果。

输入预算在请求投影之后估算，所以失败 assistant 和补出来的工具结果不会把预算算偏。估算覆盖系统提示词、系统消息、用户文本、assistant 文本、实际会发送的思考、工具名和参数、工具结果、工具名/描述/schema，以及每条消息的固定开销。图片按固定 1,200 token 计，不按 base64 长度。字符按 UTF-8 字节近似（约 4 字节一个 token），只是近似值。安全余量是 `min(4096, max(32, floor(contextWindow / 20)))`，小窗口不会被固定 4,096 占满。同一 `systemPrompt` 和内容相同的首条 system 消息只计一次。不沿用上一条 usage。schema 按当前对象计算。循环引用或无法序列化的参数在发请求前失败。

官方 OpenAI 只发送 `max_completion_tokens`。兼容端用 `completionsProvider({ outputTokenField: "max_tokens" })`，这也是该 provider 的默认字段。同一次请求只出现其中一个字段，不按模型名增加分支。

`gpt-4o-mini` 保留已核对的 128,000 上下文、16,384 输出上限和费率。其他型号必须在 `models` 或 provider 上显式给出 `contextWindow` 和 `maxTokens`，不会继承这份窗口或输出上限，也不猜测价格。未声明 `input` 时只有文本。通用 `completionsProvider` 未配置 `cost` 时费率为 0。

上下文超限先看错误 code/type（`context_length_exceeded`、`model_context_window_exceeded`），再匹配少量「最大上下文 / 最大输入」文案。不是所有 HTTP 400/413、所有 `length`，也不是 “too many tokens”。限流、配额、账单、认证和普通参数错误排除在外，超限也不会标成可原样重试。普通 `length` 仍是截断；输出为 0 且输入已占满窗口时，额外标上 `overflow`，交给 Durable 决定是否压缩。AI 只分类和限制这一次请求，不自动重发。

Chat Completions 请求带 `stream_options.include_usage`。最终消息写入服务端的 input、output 和 total token；费用按模型 `cost` 上「每 1,000,000 token 的美元」计算，缺了费率就记 0，不查价格目录。`thinkingLevel` 先按模型能力映射，不支持的级别在发请求前以错误终态结束。映射出的参数写入 `reasoning_effort`；调用方若再传协议选项 `reasoningEffort`，以该选项为准。暂时的限流、网络故障，以及 408 / 500 / 502 / 503 / 504，把消息标成 `retryable`。配额、账单、认证和参数错误不标，501 和 505 也不标。AI 只分类，不自动重发。中途失败或取消会留下已经收到的文本和工具调用，并只发布一次终态。

流内 `error` 也按错误内容分类，并保留之前的输出和 usage。错误事件形状、成功终态中不完整的工具参数、`content_filter` 和本地序列化失败均以不可重试错误结束。`length` 仍保留截断片段。Durable 将失败 assistant 保存在条目树中，在构建后续模型请求时跳过它们。

AI 的 `transformMessages` 在请求投影中跳过 `error`、`aborted`、`deferred` assistant，并为已完成 assistant 中未记录结果的工具调用补错误结果。系统消息排在同组工具结果之后，已有结果不会重复补。原始消息保留，普通 Agent 在订阅者失败后的 Completions 请求也不会发送未配对调用。

文本、思考和工具调用在第一次出现时得到稳定的 `contentIndex`，之后按这个顺序保留。服务端的 tool index 只用来认出同一次调用，不会在文本到达后把工具挪到后面，也不会按 index 重排已经出现的块。成功的流里，每个已开始的块有且只有一次结束事件。`error` 和 `aborted` 可以留下未完成的块，不会补一次成功的 `toolcall_end`。一条流只有一个消费者，也只有一个 `done` 或 `error`；已经发出的 partial 不会被后面的增量改掉。

同一套生命周期和身份检查在 `@amazme/ai/testing` 的 `checkAssistantStream`。AI 根入口不加载它，协议专有的请求字段也不放进这套检查。

流式帧带上 `contentIndex`。文本、思考和已经结束的工具调用按这个序号还原，不按结束事件的到达顺序重排。未结束的工具调用没有帧。帧即使看起来完整，也只是恢复用的前缀，不是一次已经结算的响应。Durable 崩溃恢复仍写成 `aborted`，去掉工具调用，不执行它们，也不重发请求。

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
- `compaction.maxTokens` 只决定何时按输入量压缩。生成输出上限是另一项 `maxTokens`。开启后，阈值和上下文超限最多各走一次有界摘要：专用摘要请求、保留当前输入和完整工具组、一次 `apply` 发布摘要与复制尾段。关闭时超限直接失败。显式压缩仍可用。摘要失败、取消或进程中断都不重发。这不是全模型目录，也不是 Pi 的 Conversation / Task / Chord。

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

每个上层包用 `defineTelemetrySchema` 声明自己的 span：名称、说明、允许的父关系、开始/结束/事件属性、必需与可选、值类型、枚举，以及 sensitive 和 cardinality。TypeScript 类型从这份 schema 推导。`createTypedSpanStarter` 把显式的 `TelemetryContext` 和一份或多份 schema 绑在一起；重名的 span 不能放进同一次绑定。它只做类型推导，不读取 schema，也不在运行时校验。调用仍经过被动的 `startSpan`，不直接信任适配器。AI 记录模型请求，Agent 记录内存回合和工具执行，Durable 记录 drive、重试等待、恢复和自己的工具执行。诊断词汇不下放成 Telemetry 对上层包的依赖。

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
npm run check:core
npm run check:durable
npx tsx packages/coding-agent/src/cli.ts "hello"
```

OpenAI：

```bash
npx tsx packages/coding-agent/src/cli.ts --provider openai --model gpt-4o-mini "你好"
```

这是同一套分层的独立实现，不是 Pi 仓库的拷贝。对齐范围是传统 Agent 这一路：没有 TUI、没有四十多个供应商、没有 Chord。`AgentHarness` 不支持 deferred 和摘要崩溃重试。`convertToLlm`、`transformContext`、工具前后 hook 和 `continue()` 也不在这里。
