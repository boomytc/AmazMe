# AmazMe

这是 AmazMe 的第一个大版本。宿主持有会话日志、工具和模型。全屏在 `@amazme/tui`，网页在 `@amazme/web`，两者都只附着宿主。没有版本 1 标头、但已经有数据的会话或 runtime 文件不可读，也不会被迁移。

起步于 [Pi `ed8b3bc`](https://github.com/earendil-works/pi/tree/ed8b3bcc194c8263ec8bec3f337053ae73866da1) 的 TypeScript monorepo。模型 I/O、内存里的 agent 循环、编码会话各管一层，依赖只向下。持久化运行时 `@amazme/durable` 依赖 `@amazme/ai`、`@amazme/telemetry`，以及 `@amazme/agent` 已有的 `walkBefore`、`walkAfter`、`walkTransform`、`walkYield`。`@amazme/agent` 不依赖 `@amazme/durable`。

```text
@amazme/telemetry      被动诊断契约、空实现、进程内记录
@amazme/protocol       跨进程路由信封、严格 JSON、CBOR 与分帧，只依赖 TypeBox
@amazme/client         无界面的协议客户端：握手、请求关联、取消、订阅；/unix 为 Node Unix socket 传输
@amazme/server         无界面的协议服务端：显式注册的 runtime 路由、attachment、订阅与上限；/unix 为监听器
@amazme/mcp            独立的 MCP 客户端，不依赖其余各包
@amazme/ai             Provider、认证、统一消息、流事件
@amazme/agent          内存里的 turn 循环
@amazme/durable        可崩溃恢复的 AgentHarness、存储契约与适配器
@amazme/runtime-service  Durable lane 控制、完整快照、有界订阅和历史分页；服务端打开并持有 runtime 和存储
@amazme/tui            全屏客户端：只附着宿主 socket，不持有会话、工具或模型
@amazme/web            回环网页：列会话、打开转录、提交、中止。不持有会话、工具或模型
@amazme/coding-agent   宿主、read/write/edit/bash、CLI、MCP 工具适配。全屏和网页由它拉起宿主再交给对应客户端
```

`@amazme/mcp` 是协议客户端，并带有 stdio 和 Streamable HTTP。默认先按规范修订版 `2026-07-28` 发送 `server/discover`。stdio 上，对方不是现代响应或超时时，才退回 `initialize`。HTTP 上，只有 400 且正文不是现代 JSON-RPC 错误才退回；带方法不存在的 404、超时，以及没有 JSON-RPC 正文的 404/405，都不握手。退回后接受 `2025-11-25` 及更早的三个修订版。进度会重开空闲超时，但不会推迟单次请求的绝对时限。`input_required` 直接失败，不自动再请求。旧的 HTTP+SSE 没有实现。现代 HTTP 按 `tools/list` 中合法的 `x-mcp-header` 标注生成 `Mcp-Param-*`，非法标注工具被过滤，错误参数在发送前失败。OAuth 发现、PKCE、刷新和 step-up 在独立的 `@amazme/mcp/oauth` 入口里：动态注册带 `application_type`，一个授权服务器签发的凭证不会交给另一个，包不打开浏览器，也不读真实密钥。`@amazme/coding-agent` 把已经连上的客户端适配成 Agent 工具：名字是 `mcp_<serverId>__<toolName>`，冲突或超长就报错，不截断；取消、进度、文本和图片结果交给工具执行。协议包本身不依赖 Agent。本地子进程、内存传输和注入的 fetch 都不是真实服务器或真实登录验收。调用方自己持有服务器连接。

今天的 `amazme` 单次 prompt 仍走内存循环加会话树：有一次性 prompt 时跑完这一次并退出。没有 prompt 且标准输出是终端时，全屏会启动前台宿主，视图只附着 socket。`amazme serve` 是同一条宿主：它监听 socket，打开并持有一份 JSONL runtime，`accept` 只落盘，`drive` 才推进。进程挂了以后，下一次显式 `drive` 从完整的操作状态接着做，不会自动重发已经结算的模型请求。可重试错误仍由 Durable 按存储的 `notBefore` 重发。

## 模型边界

工具参数使用 JSON Schema 2020-12，可声明 enum、数值和字符串限制、组合条件、数组约束、对象依赖和本地引用，并保留 `x-*` 注解。校验不强制转换值、不填默认值。结构不合法、未知关键字、未知 format、未知 dialect 和悬空引用都会失败；外部引用不解析。Google 的工具定义使用 `parametersJsonSchema` 字段。

`Models` 是模型查找和调用的能力接口，具体集合由 `createModels()` 返回，并用 `setProvider` 装配。认证顺序是请求里的 key、已存储的凭证、环境变量，最后是 provider 声明的 ambient。存过凭证之后，后面的来源不再作为退路。凭证存储和环境变量留在实现内部，不要求每个消费者自己持有。

根入口只导出契约、工厂和纯辅助函数。线协议与供应商从子路径导入：

```typescript
import { createModels } from "@amazme/ai";
import { openaiCompletionsApi } from "@amazme/ai/api/openai-completions";
import { completionsProvider } from "@amazme/ai/providers/completions";
import { openaiProvider } from "@amazme/ai/providers/openai";
import { fauxProvider } from "@amazme/ai/providers/faux";
```

消息只有 `system`、`user`、`assistant`、`toolResult`。`transformMessages` 负责换供应商：收短 tool call id，拿掉目标模型看不见的图片。线协议放在 `api/`，供应商文件登记目录、认证和地址。可标明的 api 有 `openai-completions`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`google-generative-ai`、`google-vertex`、`bedrock-converse-stream`、`mistral-conversations`、`pi-messages` 和 `faux`。`builtinProviders()` 返回 40 个预设供应商。预设仍走 `createProvider`，按 `model.api` 分派；该供应商的表里没有这个 api 时不发请求，以错误终态结束。`gpt-4o-mini` 仍是 `openai-completions`，OpenAI 目录里的其他型号可以是 `openai-responses`。测试用 faux provider。登录只交给带 OAuth 的供应商：CLI 打印 `auth_url` 或 `device_code`，再把凭证写入仓库外的 `~/.amazme/credentials.json`（可用 `AMAZME_CREDENTIALS` 改路径）。Bedrock 发请求前用凭证链签名；容器和 STS 凭证没有过期时间时仍可使用，已过期、无法解析或 60 秒内过期则不发请求。Vertex 发请求前读取 ADC，访问令牌距过期超过 60 秒时直接使用，否则刷新；刷新失败不发送即将过期的令牌。链或 ADC 解析失败就不发模型请求；私钥、refresh token 和凭证文件正文不写入 CredentialStore。下面关于输出上限、图片 data URL、超限分类和思考回放的约定只描述 Chat Completions，其他协议不自动套用。

`StreamOptions` 中的 `baseUrl` 和 `headers` 是各协议共用的请求配置。请求地址覆盖 Provider 默认地址，headers 按字段覆盖并保留其余默认字段。协议专用选项仍由 `ApiStreamOptions` 区分。`signal`、`apiKey`、`telemetryContext` 不会写入 JSON 请求体。

Azure Responses 的默认地址是资源下的 `/openai/v1/responses`，deployment 放在请求体的 `model` 字段，API key 使用 `api-key` 请求头。资源根地址、`/openai`、`/openai/v1` 和完整 Responses 地址会归一化。显式日期版本使用 `/openai/responses?api-version=...`；`preview` 使用 v1 路由。Azure preset 将环境里的资源地址、deployment 和版本传到请求；缺少或无效的地址在 fetch 前失败。凭证文件的同一规范绝对路径在同一进程共享整文件写链；新文件权限为 `0600`，新建私有目录为 `0700`，已有父目录权限保持原样。这不提供跨进程写锁。OAuth 取消后的请求或刷新结果不写入凭证，显式无效的有效期不替换成默认值。

`StreamOptions.maxTokens` 是这一次生成的输出 token 上限，包含协议会计入的思考 token，不再另加一份思考预算。它会传到 `stream`、`streamSimple`、Provider 和 Models。Agent 上的可选 `maxTokens` 只转发给注入的 `streamFn`，Agent 仍然不持有 Models。一次模型请求的消息替换由有序的 `transformContext` 完成，见下面的内存循环。省略时使用模型声明的输出上限；显式值仍受该上限和剩余上下文约束。放不下时不会发送 0、负数或 NaN，也不会删消息来凑预算，而是以不可重试的 `overflow` 终态结束。参数非法和上下文放不下是两种结果。

输入预算在请求投影之后估算，所以失败 assistant 和补出来的工具结果不会把预算算偏。共享的 `resolveOutputBudget` 对原始或已投影消息执行同一预算投影，Durable 与协议使用相同输入估算。估算覆盖系统提示词、系统消息、用户文本、assistant 文本、实际会发送的思考、工具名和参数、工具结果、工具名/描述/schema，以及每条消息的固定开销。图片，包括工具结果里的图片，按固定 1,200 token 计，不按 base64 长度。字符按 UTF-8 字节近似（约 4 字节一个 token），只是近似值。安全余量是 `min(4096, max(32, floor(contextWindow / 20)))`，小窗口不会被固定 4,096 占满。同一 `systemPrompt` 和内容相同的首条 system 消息只计一次。不沿用上一条 usage。schema 按当前对象计算。循环引用或无法序列化的参数在发请求前失败。

原生协议的签名和 redacted payload 也计入请求预算。Anthropic、Google 和 Bedrock 返回的签名随所属内容块或工具调用保存，并通过帧还原；只有目标 api、provider 和 model 都与来源一致时才回传。同源 Google / Vertex 工具调用与结果还会回传原始调用 ID。换模型时去掉签名，redacted 内容丢弃，可读思考按目标协议投影；源消息保持原样。不编造签名，也不合并不同签名的 Google parts。

思考参数按协议映射：Gemini 2.5 使用 `thinkingBudget`，Gemini 3 使用 `thinkingLevel`；无法关闭思考的模型明确拒绝 `off`。Google usage 的输出包含 `thoughtsTokenCount`。Claude 使用 token budget 或 adaptive thinking；token budget 严格小于总输出 cap。Bedrock Claude 使用同一映射，Nova 2 Lite 支持 low / medium 和关闭；high 要求去掉输出上限，因此当前有界输出契约明确拒绝，minimal 也不静默降级。未实现思考控制的 Bedrock reasoning 模型拒绝显式控制，省略级别则沿用服务端默认。总输出 cap 保持不变。

官方 OpenAI 只发送 `max_completion_tokens`。兼容端用 `completionsProvider({ outputTokenField: "max_tokens" })`，这也是该 provider 的默认字段。同一次请求只出现其中一个字段，不按模型名增加分支。

`gpt-4o-mini` 保留已核对的 128,000 上下文、16,384 输出上限和费率，`input` 只有文本。其他型号必须在 `models` 或 provider 上显式给出 `contextWindow` 和 `maxTokens`，不会继承这份窗口或输出上限，也不猜测价格。未声明 `input` 时只有文本，不会默认打开 vision。通用 `completionsProvider` 未配置 `cost` 时费率为 0。

用户字符串仍按文本发送。`UserContent` 数组保持原顺序：文本块是 `{ type: "text" }`，图片块是 `{ type: "image_url", image_url: { url: "data:<mimeType>;base64,<data>" } }`。模型声明了 `image` 时不再把图片换成 `[image]`。未声明图片能力的原始图片请求在降级成占位文本之前失败，不调用 fetch。调用方若已经把内容投影成纯文本，则按文本发送。能力错误和图片格式错误是两种不可重试的结果；格式检查要求 `image/*` MIME、非空 base64 数据及合法长度和 padding，错误文本不包含图片数据或提示词。这里不读文件、不解码、不上传、不抓远程图片，也没有图片生成、音频或视频。工具结果可以带图片，按目标协议序列化。Chat Completions 的工具角色只发送文本，在同一批次全部工具结果之后追加携带图片的用户消息。Google 把并行函数结果合成一个回合；Gemini 3 及之后的型号使用嵌套图片结果，旧型号和未识别的别名把图片放在随后用户消息中。未声明图片能力的模型会把工具图片换成占位文本，仍发送请求；格式不合法的工具图片在声明了图片能力时于 fetch 前失败，错误文本不包含图片数据。`transformMessages` 仍会为文本模型准备占位文本；那是显式投影，不是原始图片请求。图片仍按固定 1,200 token 计入预算。摘要里只保留附件标记，工具结果中的图片也是如此。

上下文超限先看错误 code/type（`context_length_exceeded`、`model_context_window_exceeded`），再匹配少量「最大上下文 / 最大输入」文案。不是所有 HTTP 400/413、所有 `length`，也不是 “too many tokens”。限流、配额、账单、认证和普通参数错误排除在外，超限也不会标成可原样重试。普通 `length` 仍是截断；输出为 0 且输入已占满窗口时，额外标上 `overflow`，交给 Durable 决定是否压缩。AI 只分类和限制这一次请求，不自动重发。

Chat Completions 请求带 `stream_options.include_usage`。最终消息写入服务端的 input、output 和 total token；费用按模型 `cost` 上「每 1,000,000 token 的美元」计算，缺了费率就记 0，不查价格目录。`thinkingLevel` 先按模型能力映射，不支持的级别在发请求前以错误终态结束。映射出的参数写入 `reasoning_effort`；调用方若再传协议选项 `reasoningEffort`，以该选项为准。暂时的限流、网络故障，以及 408 / 500 / 502 / 503 / 504，把消息标成 `retryable`。配额、账单、认证和参数错误不标，501 和 505 也不标。AI 只分类，不自动重发。中途失败或取消会留下已经收到的文本、思考和工具调用，并只发布一次终态。

兼容端可能在 delta 里返回 `reasoning_content`、`reasoning` 或 `reasoning_text`。同一个 chunk 里多个字段同时有值时，只取按这个顺序的第一个非空字符串，不把它们拼在一起，也不读 `reasoning_details`。空字符串和其他类型被忽略。没有这些字段时不会编造思考文本；官方 OpenAI 不保证返回内部思考。思考块和文本、工具共用 `contentIndex`。连续且字段相同的增量留在同一个块里；字段变了，或中间插入了文本/工具，就是新块。块记下第一次出现的字段。错误、取消和帧恢复都保留已经收到的片段。帧上的 `thinkingField` 只可能是这三个名字。

下一轮请求里，目标仍是 `openai-completions` 且块带有上述字段时，思考按该字段回放，不写进 assistant 的普通 `content`。同一个字段的多块用换行拼起来。字段名不在这三个之内时，不会变成 JSON 键。其他协议按各自的原生思考与签名规则投影。源消息不被改写。Completions 没有完整的 `reasoning_details` 支持。

流内 `error` 也按错误内容分类，并保留之前的输出和 usage。错误事件形状、成功终态中不完整的工具参数、`content_filter` 和本地序列化失败均以不可重试错误结束。`length` 仍保留截断片段。Durable 将失败 assistant 保存在条目树中，在构建后续模型请求时跳过它们。可重试错误只由 Durable 重发。等待时间来自 lane 配置里的 `retry`，结算时写成 `notBefore`。模型请求另有 `requestTimeoutMs`，和工具执行时限分开：还没有内容帧时，截止变成可重试错误；已经有内容帧时不再重发，帧里的工具调用不执行。

空响应也先发布 `start`；成功终态中的工具参数必须完整，包括 `length`。不完整 JSON 留在失败前缀中，不发布成功的 `toolcall_end`。原生协议使用相同的占满窗口判断；明确的 `model_context_window_exceeded` 会标记 `overflow`，普通 `length` 不一律当成超限。SSE 和 AWS event stream 在挂起读取时也响应取消，取消后不继续消费已缓冲的后续块。

AI 的 `transformMessages` 在请求投影中跳过 `error`、`aborted`、`deferred` assistant，并为已完成 assistant 中未记录结果的工具调用补错误结果。系统消息排在同组工具结果之后，已有结果不会重复补。原始消息保留，普通 Agent 在订阅者失败后的 Completions 请求也不会发送未配对调用。

文本、思考和工具调用在第一次出现时得到稳定的 `contentIndex`，之后按这个顺序保留。服务端的 tool index 只用来认出同一次调用，不会在文本到达后把工具挪到后面，也不会按 index 重排已经出现的块。成功的流里，每个已开始的块有且只有一次结束事件。`error` 和 `aborted` 可以留下未完成的块，不会补一次成功的 `toolcall_end`。一条流只有一个消费者，也只有一个 `done` 或 `error`；已经发出的 partial 不会被后面的增量改掉。

同一套生命周期和身份检查在 `@amazme/ai/testing` 的 `checkAssistantStream`：检查消息 start、内容块增量与 partial 一致性，以及成功终态和已结束块的完整内容。AI 根入口不加载它，协议专有的请求字段也不放进这套检查。

流式帧带上 `contentIndex`。文本、思考和已经结束的工具调用按这个序号还原，不按结束事件的到达顺序重排。未结束的工具调用没有帧。帧即使看起来完整，也只是恢复用的前缀，不是一次已经结算的响应。Durable 崩溃恢复仍写成 `aborted`，去掉工具调用，不执行它们，也不重发请求。

## 内存循环

每个 `transformContext` 收到独立的消息快照；只有返回数组才会替换请求投影，返回 `undefined` 时的原位修改丢弃。投影过滤 custom 消息后才进入 AI 协议，Agent 和 Durable 使用同一规则。`onYield` 等待结束后重新检查取消与 steer / follow-up；等待期间到达的队列优先，取消后不追加 yielded 消息。

一次 turn 是一次模型响应加上它的工具结果。Agent 不持有 Models。每次模型调用都走构造时传入的 `streamFn(model, context, options)`，它可以同步返回事件流，也可以异步取得事件流。`models.streamSimple.bind(models)` 满足这个形状。`hooks` 按顺序折进原有循环：`beforeToolCall` 可以拦截执行，`afterToolCall` 只改已经执行的结果的 `content`、`isError` 和 `terminate`，`transformContext` 只替换这一次模型请求的消息，不写回 transcript，也不另开一条循环。认证和 Provider 装配留在调用方。未传 `telemetryContext` 时使用空实现；要和某次 Models 共享诊断上下文，由调用方把那个上下文传进来。Steering 在当前 assistant 回合之后进入。Follow-up 要等到这次 run 本来会停的时候。模型已经结束、这一轮没有工具调用、steer 和 follow-up 都为空时，`walkYield` 可以追加一条普通 user 消息并再请求一次模型；没有可追加的文本就停止。排队中的 steer 或 follow-up 先走，这个钩子不插入。工具轮和 terminate 不调用它。`stopReason === "length"` 的 tool call 不执行。工具可以并行跑完，写回 transcript 时仍按 assistant 里的源顺序。

## 持久化运行时

`@amazme/durable` 的会话日志是宿主唯一的转录。同一份存储可以有多段对话；`fork` 从已有条目另开一段，两边随后各自延伸。模型适配器和工具执行都由打开参数替换。工具结果过长时，只有下一次模型请求看到裁剪后的投影，日志里的原文不变。压缩同样只改变之后的请求投影。没有版本 1 标头、但已经有数据的会话或 runtime 文件直接拒绝，不迁移。`AgentHarness` 和 `AgentLane` 仍是入口。Pi 的 Conversation、Task、Document 还不在本仓库里。运行时依赖结构化的 `HarnessModels` 能力接口，只要求模型查找、流式调用与可选诊断上下文；`createModels()` 可直接使用。`HarnessOptions.hooks` 使用 `@amazme/agent` 的 `AgentHook`。`drive` 在存储事务外、武装工具前调用 `walkBefore`；这段等待中的取消不执行，也不进入 `walkAfter`。`walkAfter` 只在 `execute` 正常返回之后、写入结果之前；`execute` 抛错时不调用它，错误文本仍作为工具结果提交。`walkTransform` 只在助手请求和摘要请求调用 `streamSimple` 之前替换这一次的 messages。变换结果不写回条目。模型已经结束、这一轮没有工具调用、steer 和 follow-up 都为空时，`drive` 才调用 `walkYield`：非空白字符串追加成一条 user 消息，并和随后的阶段在同一次 apply 里提交，然后再请求一次；空结果则完成。`onYield` 抛错发生在写入之前，不留下 live id，也不重发已经结算的 `streamSimple`。工具轮、terminate、摘要和 navigation 不调用它。`HarnessTool`、`ToolResult`、`HarnessMessage` 仍属于 Durable 自己的契约，不与 Agent 的同名类型合并。更多使用方式见 [Durable README](packages/durable/README.md)。

存储只有三类东西：只写一次的 entry 树、可替换的 value 和只追加的 list、只追加的 usage。一次 commit 要么全部可见，要么全部没有。`StorageView.version()` 公开覆盖全部写入的存储总 seq。`AgentLane.snapshot()` 在一次读取里返回版本、lane 状态、当前分支 entries 和主 assistant 已持久化的未结算回复前缀；`AgentLane.result()` 只读已结算结果。两者都返回深拷贝，不推进 `drive`，也不触发恢复。

工具只有在武装提交成功返回后才登记本进程的 live 标记；提交失败后，同一 harness 再 `drive` 仍可按持久化阶段恢复。`abandon()` 在 hook 等待返回、工具启动和存储回调入口阻止继续推进，已提交数据留给新 harness 恢复。

一条 lane 同时最多一个操作。操作状态是一整份当前叶子，每次转移都整份替换。恢复时读这棵叶子，不回放日志。

- 模型请求在 `assistant_effect_pending` 里预留 response id 和 usage id，然后才发送。中途崩溃就用已经写下的帧合成一条 `aborted` 响应，不再次发送。
- 响应和摘要结算把 entry、usage、tip 与阶段转移或操作终态一起提交。未结算状态的预留 entry / usage ID 必须尚未被占用；不一致的状态直接报错。
- 工具先写 intent。`replay: "never"` 的工具不重跑，结果里带上最后一次 checkpoint。`replay: "safe"` 用存下来的参数再执行。
- 多个工具可以乱序完成，entry 仍按源顺序挂到树上。
- 结束时删掉操作自己的 value，留下不可变的 `pi.result`，其中保存所属 lane。结算后和重启后都只允许所属 lane 读取，缺少归属的结果属于无效数据。
- `compaction.maxTokens` 只决定何时按输入量压缩。生成输出上限是另一项 `maxTokens`。开启后，阈值和上下文超限最多各走一次有界摘要：专用摘要请求、保留当前输入和完整工具组、一次 `apply` 发布摘要与复制尾段。关闭时超限直接失败。显式压缩仍可用。摘要失败、取消或进程中断都不重发。

Harness 依赖结构化的 `Storage` / `StorageView` 接口，后端不需要继承 `MemoryStorage`。`run` 串行持有写入通道，每次 `apply` 单独原子提交；它不是跨多个 `apply` 的事务，回调失败也不会撤销此前已提交的数据。`apply` 仅在所属回调未结束时有效。

核心入口和 `MemoryStorage` 不导入 Node 模块，ID 使用 Web Crypto；没有全局 `process` 时，模型认证使用传入的 `env` 或空环境。JSONL 使用独立 Node 入口。`openJsonlOwner` 在重放文件之前取得本机排他写入权；`new JsonlStorage` 不取锁。

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

内置工具是 `read`、`write`、`edit`、`bash`。`read` 可以重放，`write`、`edit` 和 `bash` 不行。这四个工具共用一条工作区策略：工作区可写，`<workspace>/.amazme` 不可读写，只有 `<workspace>/.amazme/tmp` 例外，工具没有网络。darwin 用 Seatbelt，linux 用 Bubblewrap（`--unshare-net`，把 `.amazme` 盖成 tmpfs 后再绑回 tmp）。平台不对，或对应的 `sandbox-exec` / `bwrap` 不存在时，工具抛出 `SANDBOX_UNAVAILABLE`，不会退回不受限制的进程。模型请求和调用方自己持有的 MCP 工具不在这道边界里。

CLI 和全屏都把工作目录下 `skills/` 里的 `SKILL.md` 合成一段文字，接在已经传给 Agent 的 `systemPrompt` 后面。只读该目录自己的文件和每个直接子目录里的 `SKILL.md`。`disableModelInvocation: true` 的技能不进入；目录不存在或没有可显示的技能时，提示词保持原样。`amazme attach --socket`、全屏和 `amazme bridge` 用同一套斜杠命令。`/help` 列出它们。以 `/` 开头但无法识别的行不会发给模型。`/new`（`/clear`）、`/resume`、`/fork`、`/clone`、`/rewind`（`/undo`）和 `/compact` 改当前会话；`/model`（`/m`）和 `/thinking`（`/effort`）改当前空闲 lane 的模型和思考级别；`/login`、`/logout` 不带参数时在全屏里打开供应商列表，标出已保存和未配置，再选择账号登录或 API key；带上提供方 id 时仍直接登录。凭证写在本机凭证文件；`/steer`、`/abort`、`/continue`、`/earlier` 沿用原来的 lane 操作。`/continue` 只对已经写下的 `retry_wait` 再 `drive`，并等到 `notBefore`。`/quit` 只离开全屏；页面和附着端不停止宿主。没有提示词时的全屏把用户消息放在带边的块里，助手文本按标题、列表和代码块排开，工具单独成块。底栏有工作目录、会话、模型和忙闲，输入行在横线下面。`/model`、`/thinking`、`/resume` 和 `/login` 不带参数时打开可筛选列表。网页用同一套块和底栏。`amazme bridge --socket [--port n]` 只监听 `127.0.0.1`。页面列出会话、打开一段转录、提交提示，并在命令结果处显示说明。这些客户端都不持有 JSONL，也不执行工具，也不调用模型。

`appendMcpTools` 把调用方已经列出的 MCP 工具接在这四个编码工具之后。每个服务器带 `serverId`。暴露给模型的名字是 `mcp_<serverId>__<toolName>`，两边都只允许 `[A-Za-z0-9_-]`。超过 64 个字符，或和数组里已有工具（包括 `read`、`write`、`edit`、`bash`）或其他服务器算出的名字冲突时，抛出错误并写明两边的身份，不截断、不改写字符。`execute` 把取消信号和进度交给 `client.callTool`，文本和图片都进入工具结果。`mcpServer` 可以包住一个已经连接的 `@amazme/mcp` 客户端，并使用它的内容投影。库导出本身不打开传输。`amazme serve` 在打开 runtime 时读取 `<cwd>/.amazme/mcp.json`：文件不存在就没有 MCP；文件无效或某个服务器连不上，这次打开失败，码是 `mcp_unavailable`。连接跟这次 runtime 走，客户端断开不断开它们。MCP 调用留在宿主进程里，继承宿主环境，不进 Seatbelt。一次性命令不读这份配置。全屏和 `amazme serve` 都会读。没有服务器或列表为空时，工具数组不变。

没有一次性 prompt 且标准输出是终端时进入全屏。全屏启动宿主后把画面交给 `@amazme/tui`。提交、中止和斜杠命令都发给宿主，不走内存会话的 `session.prompt`。

## 命令

`npm test` 包含真实 Unix socket 的测试，需要允许本地监听的环境；受限沙箱中的 `listen EPERM` 是环境限制，不是实现失败。

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
npx tsx packages/coding-agent/src/cli.ts login --provider openai --method device_code
```

不带 prompt、且标准输出是终端时，`amazme` 进入全屏，而不是报 missing prompt。

前台宿主：

```bash
npx tsx packages/coding-agent/src/cli.ts serve --socket /tmp/amazme.sock --cwd .
```

它只承认 runtime `workspace`。这份日志里的每条对话 lane 都可以附着，`main` 只是默认。JSONL 在 `<cwd>/.amazme/runtime/workspace.jsonl`，和一次性命令的会话树分开。客户端不能传路径或构造参数。已有 lane 的模型、系统提示词和技能文本只在第一次写入；重开改 `--model` 不会覆盖。显式 `/model` 和 `/thinking` 会改当前空闲 lane，并把这次选择作为之后新建 lane 的默认；其他已经存在的 lane 保持原配置。这两条命令不改系统提示词。正在进行的操作上拒绝写入。未知模型和不被该模型接受的思考级别会拒绝，不会夹到别的级别。工具每次用当前进程的 `read` / `write` / `edit` / `bash`。`read` 可以重放，另外三个崩溃后不重放。第一次 `SIGINT` 或 `SIGTERM` 排空后退出，不删除文件；排空过程中的第二次信号改为中止。

这是同一套分层的独立实现，不是 Pi 仓库的拷贝。编码命令有全屏视图和 40 个预设供应商；登录、技能段落和 MCP 工具追加都在这一层。当前 `AgentHarness` 没有 deferred，摘要中断后不重试，也没有 `convertToLlm`。排队的 steer 和 follow-up 在同一次 `prompt` 或 `drive` 里消化。
