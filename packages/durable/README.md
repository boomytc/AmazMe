# @amazme/durable

这是 AmazMe 第一个大版本的持久化运行时。没有版本 1 标头、但已经有数据的会话或 runtime 文件直接拒绝，不迁移。

持久化 lane 运行时。依赖 `@amazme/ai`、`@amazme/telemetry`，以及 `@amazme/agent` 的 `walkBefore`、`walkAfter`、`walkTransform`、`walkYield`。`@amazme/agent` 不依赖本包。运行语义保持本仓库现有设计，不另建 hook 类型或第二套遍历。

## 入口与使用

```typescript
import { createModels } from "@amazme/ai";
import { deepseekProvider } from "@amazme/ai/providers/deepseek";
import { AgentHarness } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";

const models = createModels();
models.setProvider(deepseekProvider());
const harness = new AgentHarness(new MemoryStorage(), {
  models,
  model: { provider: "deepseek", modelId: "deepseek-flash" },
});
try {
  const admitted = await harness.lane("main").accept({ kind: "prompt", text: "hello" });
  if (!admitted.ok) throw new Error(admitted.error.message);
  const outcome = await harness.lane("main").drive(admitted.value.operationId, { waitForRetry: true });
  if (!outcome.ok) throw new Error(outcome.error.message);
  console.log(outcome.value);
} finally {
  await harness.close();
}
```

`accept` 持久化操作与消息，`drive` 推进模型调用、工具、摘要与结算。`prompt` 合并这两个步骤。

`drain()` 停止新的 accept、drive、steer、follow-up 和 requestAbort，并等待已经准入的 drive、经 lane 准入且还在排队的存储操作，然后等待此时的存储队列。直接调用传入的 Storage 不计入这次等待。它不中止正在运行的模型或工具，也不写入 `requestAbort`。`close()` 在此之上中止 harness 信号。已经取出的模型结果和工具结果仍会结算；尚未发出的模型调用不会开始。不响应信号的工具会让 `close()` 一直等待，存储不会因此提前关闭。不要在存储回调里等待 `close` 或 `drain`，否则会和正在执行的回调互相等待。并发调用共享同一次等待；存储排空失败后可以重新等待，准入仍保持关闭，成功后的等待继续复用。两者都不关闭 Storage，也不隐式重发模型请求。`retry_wait` 里持久化的 `notBefore` 仍是结算时写入的时间；没有正在执行的 drive 时，它不算作运行中的工作。`idle()` 为真表示没有进行中的 drive，也没有经 lane 准入的存储操作。`watchIdle` 在这些工作开始或结束时通知，注册当下的状态不会补发。直接调用传入的 Storage 不改变 `idle()`。

| 入口 | 内容 |
| --- | --- |
| `@amazme/durable` | Harness、lane、操作与消息类型、只读快照与结果 DTO、Storage 契约、`value` / `list` 地址辅助函数 |
| `@amazme/durable/storage/memory` | 可移植的内存参考实现 |
| `@amazme/durable/storage/jsonl/node` | Node 文件系统 JSONL。`openJsonlOwner` 取得排他写入权；`new JsonlStorage` 不取锁 |
| `@amazme/durable/testing` | 独立于测试框架的共享存储契约检查，仅此测试入口使用 Node 断言 |

核心入口和内存后端可在没有 Node 模块、全局 `process` 或业务客户端的环境中使用。入口会加载 `@amazme/agent` 的 hook 遍历。需要持久化文件时显式导入 Node 适配器：

```typescript
import { value } from "@amazme/durable";
import { openJsonlOwner } from "@amazme/durable/storage/jsonl/node";

const owner = openJsonlOwner("./state/lane.jsonl");
try {
  await owner.storage.commit([{ type: "set", address: value("lane"), value: 1 }]);
} finally {
  await owner.release();
}
```

## 依赖与能力契约

`HarnessModels` 只要求 `getModel`、`streamSimple` 和可选的 `telemetryContext`，无需继承 `Models` 或提供认证存储、目录修改等额外能力。`createModels()` 返回的对象直接满足接口。

`HarnessOptions.hooks` 使用 `@amazme/agent` 的 `AgentHook`。`drive` 调用已导出的遍历：`walkBefore` 在存储事务外等待，仍在 `live.add` 和 `effect_pending` 之前；这段等待中的取消不武装、不执行，也不进入 `walkAfter`，而 `beforeToolCall` 返回的 block 仍记下拦截原因。`walkAfter` 只在 `execute` 正常返回之后、`stageTool` 之前；`execute` 抛错时不调用它，错误文本仍作为工具结果提交。`walkTransform` 只在 `streamAssistant` 和 `streamSummary` 调用 `streamSimple` 之前替换该次请求的 messages，不写回条目。`walkYield` 只在模型已经结束、这一轮没有工具调用、steer 和 follow-up 都为空时调用。返回的非空白字符串追加成一条普通 user 消息，并和随后的 `assistant_ready` 或 `summary_deciding` 在同一次 apply 里提交，然后再请求模型；没有可追加的文本就完成。不会留下「tip 已是这条 user 消息、操作仍停在 checkpoint / may_finish」的提交。第一个非空白字符串生效，后面的 `onYield` 不再调用。抛错发生在写入之前：不留下 live id，阶段仍是这次 checkpoint，下一次 `drive` 在钩子返回字符串之前不会重发已经结算的 `streamSimple`。工具轮、terminate、摘要和 navigation 不调用它。terminate 不会因此再请求模型。`HarnessTool`、`ToolContext`、`ToolResult`、`HarnessMessage` 仍由 Durable 自己定义，不与 Agent 的同名类型合并。工具重放策略保存在操作状态中。

`Storage` / `StorageView` 是结构化接口。后端可以自行实现，无需继承 `MemoryStorage`。`run` 串行持有写入通道；其中每次 `apply` 分别原子提交，不跨多个 `apply` 回滚。借出的 view 数据应只读，写入时将 payload 的所有权交给存储。`apply` 在所属回调结束后失效。

每个 transform hook 使用独立消息快照，只有返回数组生效，custom 消息在 AI 请求前过滤。`onYield` 等待期间到达的 inbox 优先处理，取消后不追加返回文本。`abandon()` 与 signal 取消分别检查：before / after / transform / yield 等待返回后、工具启动前及排队的存储回调入口都停止推进；保留已经提交的数据供新 harness 恢复。工具武装提交成功返回后才登记 live，提交失败不会留下导致同一 harness 卡住的运行标记。

## 只读观察

`StorageView.version()` 返回该视图看到的存储总 seq。entry、usage、set、delete、append、deleteList 每一种写入都会推进它，被拒绝的整批不推进；`commit` 返回的 `seq` 与随后读到的版本一致。版本属于整个 Storage，其他 lane 的写入也会推进它，一次发布可能跳过多个号，不代表事件条数。JSONL 重开时由同一个 reducer 重放得到相同版本，不另外存版本，也不增加 fsync 或断电承诺。自定义后端需要实现这个方法，`@amazme/durable/testing` 的契约检查包含对应用例。

`AgentLane.snapshot()` 在一次同步 `storage.read` 中返回 `LaneSnapshot`：`version`、`inspect()` 的全部状态字段、当前 tip 的祖先 entries、`pendingResponse`，以及当前操作的 `tools`。`tools` 只列出尚未离开 tools 阶段的调用：`planned`、`running`（`effect_pending`）、`settled`（`outcome_ready` 或 `completed`）。已结算的调用只在 entries 里。所有字段都是深拷贝，修改返回值不会影响存储或之后的快照；同一版本下投影相同，不含查询时间。查询不初始化 lane、不推进 `drive`、不触发恢复，也不调用模型或工具。`history(before, limit)` 读取 `before` 之前的祖先，`before: null` 是最新的一页，最多 100 条，并给出更早的条数。它同样不推进。

`pendingResponse` 只投影主 assistant 已持久化的回复前缀：阶段为 `assistant_effect_pending` 时，用 `reduceFrames` 合并已存帧，得到 `operationId`、`responseEntryId`、`content`、`stopReason` 与 `errorMessage`。没有 stop 帧时后两者为 `null`。stop 帧不是结算，不会补造 `aborted`、usage 或时间戳，也不会包装成 `AssistantMessage`。工具调用只在 `toolcall_end` 之后进入帧，参数完整，但未结算前不执行。摘要流不写帧，所以摘要期间为 `null`。结算在同一次 apply 中写入 entry 并删除帧，之后回复只出现在 entries 里。`pendingResponse` 存在只说明持久化状态里有预留的未结算回复，不代表某个进程此刻一定还在生成；崩溃后需要显式 `drive` 才会按既有策略恢复。

`AgentLane.result(operationId)` 只读取已经持久化的 `OperationResult` 并返回深拷贝。尚未结算或未知的操作返回 `{ ok: true, value: null }`；结果或进行中的操作属于其他 lane 时返回 `operation_mismatch`。它不调用 `drive`，也不生成 retry 或 `notBefore`。`inspect()` 和 `entries()` 保持原来的轻量读取，不复制整份 transcript。

## 原子结算与恢复

一条 lane 同时最多一个操作。完整操作状态保存在叶子中，恢复时读取它。响应、usage、tip 与阶段转移或操作终态在一次 `apply` 中提交。模型响应和摘要使用发送前预留的 entry ID。

- 未结算的模型流用已存帧生成 `aborted` 响应，不重发请求。帧按内容块序号还原文本、思考和已结束的工具调用；思考帧可以带上收到它的 completions 字段。恢复时仍去掉工具调用，未结束的工具调用没有帧，所以都不会执行。思考片段留在这条 aborted 消息上。帧或响应结算写入失败时，先等待已接受的帧写入收尾，再清理本进程的运行标记；同一 harness 再次 `drive` 也走中断恢复，不重发普通请求或摘要。
- `replay: "never"` 的未结算工具不重跑，结果保留最后一次 checkpoint。
- `replay: "safe"` 的工具使用持久化参数重跑。
- 并行工具完成后，entry 按 assistant 中的源顺序写入。

未结算状态的预留 entry / usage ID 必须尚未被占用。不一致的持久化状态直接报错，不尝试补写阶段或猜测归属。复制尾段的预留 ID 同样不能已经被占用。仓库处于初始开发阶段，不提供旧包入口别名、旧数据转换或旧格式修补分支。

## 模型请求截止

一次模型请求有自己的截止时间 `requestTimeoutMs`，默认 60 秒，写在 lane 配置里。它只包住 `streamSimple`，不包住工具执行。`@amazme/ai` 只把可重试错误标成 `retryable`，不重发。Durable 是唯一会重发的一层。

截止在任何内容帧之前到达，并且这次尝试还没用完 `maxAttempts` 时，结算成可重试的模型错误，错误文本是 `model request timed out`。内容帧指文本、思考或已结束的工具调用；单独的 stop 帧不算。重试等待是 `retryDelayMs`：第 n 次重试（从 1 计）等待 `min(baseDelayMs * 2^(n-1), maxDelayMs)`。默认基数 1 秒，上限 60 秒。这个毫秒数在同一次 `apply` 里写成 `retry_wait.notBefore`，不是 `Date.now() + 10`。`drive({ waitForRetry: true })` 等到该时间或被中止。调用方取消优先于截止，不会被当成超时重试。

已经写出内容帧之后到达截止，操作以 `aborted` 结束，错误文本是 `model request timed out after output started`。不重发这次请求。已有帧里的工具调用从结算消息里去掉，不执行。进程在结算前退出时，重新打开仍从已提交的操作恢复：已结算的模型结果不重发，`replay: "never"` 的工具不重跑。

缺少 `requestTimeoutMs` 或 `retry` 的 lane 配置直接失败，不补一个固定的短等待。摘要请求使用同一个截止；摘要超时记成中止，不重试摘要。

## 会话日志

条目树就是会话日志，没有第二份转录。`providerContext` 从当前 tip 的祖先投影出下一次模型请求。`models` 是模型适配器，`tools` 的 `execute` 是执行后端，两者都在 `AgentHarness` 构造时传入，测试替换它们时不改这个入口。

一份存储里的每条 lane 是一段对话。`conversations()` 列出它们。`fork(name, entryId)` 把另一段对话的 tip 放在本段已有条目上，不移动本段 tip，也不取消本段已经准入的等待。目标 lane 已经存在时拒绝，不改它的 tip。子对话复制本段已经写下的配置。子对话上的 `requestAbort` 只中止那一条 lane 的信号。

`configure` 读取或更换本 lane 的 provider、modelId 和 thinkingLevel。读取在操作进行中也可以。写入只在 lane 空闲时成功，并成为之后新建 lane 的默认模型和思考级别；已经有配置的 lane 保持自己的配置。系统提示词不在这次写入里。模型必须存在于构造时传入的 `models`。思考级别必须是该模型 `supportedThinkingLevels` 里的一项，不支持就拒绝，不夹到别的级别。

`toolResultLimit` 默认 8,000 个字符。超过的工具结果只在下一次模型请求里被裁成首尾加 `[truncated]`。日志条目保持原文字。压缩也只改变之后请求能看见的范围，不改已经写下的工具结果。

空日志第一次打开写成 `{ version: 1 }`。已经有条目、值、列表或 usage，但没有这个版本的文件是 v1 之前的会话或 runtime，直接抛出 `pre-v1 session file`，不补写、不转换。其他版本号同样拒绝。

## 上下文预算与压缩

`compaction.maxTokens` 是自动压缩的输入 token 阈值，不是这一次生成的输出上限。`HarnessOptions.maxTokens` 传给普通 `streamSimple`。摘要请求使用自己的输出上限，`tools` 为空，`thinkingLevel` 为 `off`。

模型不能关闭思考或协议尚未实现该控制时，摘要请求明确失败并保留原分支；当前摘要契约不会默默改成其他思考级别。原生签名随帧和消息保留，但崩溃恢复生成的 `aborted` assistant 仍不进入后续模型请求。

`compaction.enabled` 同时控制阈值压缩和超限恢复。关闭时这两类明确失败；显式 compaction 和带 `summarize` 的 navigation 仍可执行。每个 operation 最多做一次超限恢复压缩。普通暂时错误仍按 `maxAttempts` 重试，超限不原样重试。

阈值受模型窗口、输出预留和安全余量约束。大窗口预留 4,096，小窗口预留窗口的 1/16 且至少 32。保留尾段最多 8,192，小窗口按窗口的 1/8 缩放且至少 64，同时不超过有效阈值的一半。摘要输出上限约为预留的一半，且不超过模型输出上限。

选择使用当前模型看得见的上下文：从最近一次 compaction 开始，跳过 `error`、`aborted`、`deferred` assistant。工具调用和配套结果整组移动。末尾还没回答的用户消息保留原文。更早的轮次可以进入摘要，一条很早的用户消息不会把它后面的历史全部钉住。已有摘要会写进下一次摘要，而不是在新摘要旁边再叠一条前缀。没有旧内容时结果是 `nothing to compact`。当前输入、系统提示词和工具定义已经放不下时直接失败，不截断当前输入，也不删掉工具定义。

摘要不用普通请求的 messages 和 tools。系统提示词是摘要指令，旧会话串成一条 user 消息，原来的系统指令只作为待摘要文本。角色标成 User、Assistant、ToolCall、ToolResult。用户消息和工具结果里的图片只留下 `[Image attachment]`，不写入图片数据，也不表示模型看见了图片。旧内容放不下时先缩短旧工具输出，再缩短其他旧文本，保留首尾和 `[truncated]`，不改原始条目。缩到无法构成请求就失败，原分支保持。只调用一次摘要，不重试，也不做多级摘要。

可以发布的摘要必须是成功结束的非空文本。`error`、`aborted`、`toolUse`、空文本和 `length` 截断都不发布，也不用固定字符串代替。

发送摘要前持久化选定范围、源 tip、保留条目、预算和预留 ID。计划里没有工具定义快照、密钥或 `telemetryContext`。resume 和 finish 在一次 `apply` 中写入摘要 entry、复制出的完整尾段、这次摘要的 usage、tip，以及下一阶段或终态。复制条目使用新 entry ID，原条目不变，工具调用 ID 仍和结果对应，复制本身不加 usage。没有尾段时 tip 指向摘要。navigation 把离开分支的摘要挂到目标，目标可以是 `null`；不把该分支的近期消息接回目标，也不修改目标上已有的条目。

无效摘要和取消不发布摘要，也不发布半截尾段。resume、finish 和 navigation 发布前均用生成的摘要核对后续请求容量；摘要仍放不下时保留原分支与 tip。手动压缩也先检查必须保留的当前输入是否能容纳，放不下时不调用摘要。已经拿到的 usage 和失败或取消终态一起结算；没拿到的不补造。结算时再次看 `cancel_requested`。摘要过程中到达的 inbox 留到下一次检查点，不丢、不重复放。摘要中途崩溃则结束操作，不重发摘要或原请求。JSONL 里一条完整记录包含整笔发布，撕裂的尾部仍按最后一行完整换行截断。

故障注入测试覆盖提交前、完整记录写入后、记录尾部撕裂，以及恢复再次中断。存储契约检查对内存与 JSONL 后端执行同一套用例。

## 检查与范围

在仓库根目录运行：

```bash
npm run check:durable
npm run test --workspace @amazme/durable
npm test
```

`check:durable` 检查全部包源码、Durable 测试和跨运行时集成测试的类型。包内 `npm run check` 检查 Durable 源码与测试；跨运行时的诊断和依赖边界测试位于根目录 `test/`。

当前实现覆盖独立运行时、能力接口、平台适配器入口与契约检查。运行时是 lane：`AgentHarness` 在一次操作里驱动模型、工具和摘要。尚未包含 Pi 的 Conversation、Task、Document，也尚未包含 deferred、模型请求重发和摘要崩溃重试。

`new JsonlStorage(file)` 在构造时重放并截断撕裂尾行，不取锁，只适合单进程。跨进程写入用 `openJsonlOwner(file)`：先取得路径锁，打开文件描述符并取得 inode 锁，再通过同一个描述符重放、修复尾行和追加。符号链接和相对路径落到同一路径锁；硬链接靠设备号和 inode 互斥。路径被替换后，现有 owner 的 I/O 仍留在原 inode，不会写入替换文件。两把锁在账户数据库所给主目录的私有目录 `.amazme-jsonl-locks/{path,inode}` 下，不受 `HOME`、`TMPDIR` 或数据目录删除影响。目录必须属于当前账户且没有组或其他用户权限；每次读取回调和提交都校验持有的锁目录身份、权限和所有者令牌，归属丢失后拒绝读写和删除。释放也核对目录身份和令牌，旧实例不能解开新实例的锁。活着的进程不会因为锁时间旧而被抢占。`kill(pid, 0)` 没有返回 ESRCH 时不回收，pid 被无关进程复用时也一样。空目录、坏记录或主机名对不上时返回 `StorageBusyError`（`storage_busy`），不覆盖。`close()` 停止新的存储回调、等待已经准入的队列并关闭文件描述符，不删除、不解锁。`deleteData()` 只在路径上的 inode 仍是打开时的那一个时删除文件，失败则保持锁。`release()` 先等待存储停止，再解开两把锁；失败可以重试，成功后再调用不会动新的锁。不要在存储回调里等待这三步，否则会和正在执行的回调互相等待。不返回的回调会让它们一直等，不能靠超时提前关文件或放锁。范围只限本机本地文件系统，不保护绕过管理入口的文件操作或存储写入。锁目录在 `mkdir` 之后、写入所有者之前崩溃时，空目录无法确认归属，会一直返回 `storage_busy`。JSONL 仍不在每次写入后 fsync。
