# @amazme/durable

持久化 lane 运行时。依赖 `@amazme/ai`、`@amazme/telemetry`，以及 `@amazme/agent` 的 `walkBefore`、`walkAfter`、`walkTransform`、`walkYield`。`@amazme/agent` 不依赖本包。运行语义保持本仓库现有设计，不另建 hook 类型或第二套遍历。

## 入口与使用

```typescript
import { createModels } from "@amazme/ai";
import { fauxProvider } from "@amazme/ai/providers/faux";
import { AgentHarness } from "@amazme/durable";
import { MemoryStorage } from "@amazme/durable/storage/memory";

const models = createModels();
models.setProvider(fauxProvider());
const harness = new AgentHarness(new MemoryStorage(), {
  models,
  model: { provider: "faux", modelId: "faux-1" },
});
try {
  const admitted = await harness.lane("main").accept({ kind: "prompt", text: "hello" });
  if (!admitted.ok) throw new Error(admitted.error.message);
  const outcome = await harness.lane("main").drive(admitted.value.operationId, { waitForRetry: true });
  if (!outcome.ok) throw new Error(outcome.error.message);
  console.log(outcome.value);
} finally {
  harness.close();
}
```

`accept` 持久化操作与消息，`drive` 推进模型调用、工具、摘要与结算。`prompt` 合并这两个步骤。

| 入口 | 内容 |
| --- | --- |
| `@amazme/durable` | Harness、lane、操作与消息类型、Storage 契约、`value` / `list` 地址辅助函数 |
| `@amazme/durable/storage/memory` | 可移植的内存参考实现 |
| `@amazme/durable/storage/jsonl/node` | Node 文件系统 JSONL 适配器 |
| `@amazme/durable/testing` | 独立于测试框架的共享存储契约检查，仅此测试入口使用 Node 断言 |

核心入口和内存后端可在没有 Node 模块、全局 `process` 或业务客户端的环境中使用。入口会加载 `@amazme/agent` 的 hook 遍历。需要持久化文件时显式导入 Node 适配器：

```typescript
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
const storage = new JsonlStorage("./state/lane.jsonl");
```

## 依赖与能力契约

`HarnessModels` 只要求 `getModel`、`streamSimple` 和可选的 `telemetryContext`，无需继承 `Models` 或提供认证存储、目录修改等额外能力。`createModels()` 返回的对象直接满足接口。

`HarnessOptions.hooks` 使用 `@amazme/agent` 的 `AgentHook`。`drive` 调用已导出的遍历：`walkBefore` 在 `armTools` 里、`live.add` 和 `effect_pending` 之前；`walkAfter` 在 `execute` 返回之后、`stageTool` 之前；`walkTransform` 只在 `streamAssistant` 和 `streamSummary` 调用 `streamSimple` 之前替换该次请求的 messages，不写回条目。`walkYield` 只在模型已经结束、这一轮没有工具调用、steer 和 follow-up 都为空时调用。返回的非空白字符串追加成一条普通 user 消息，并和随后的 `assistant_ready` 或 `summary_deciding` 在同一次 apply 里提交，然后再请求模型；没有可追加的文本就完成。不会留下「tip 已是这条 user 消息、操作仍停在 checkpoint / may_finish」的提交。第一个非空白字符串生效，后面的 `onYield` 不再调用。抛错发生在写入之前：不留下 live id，阶段仍是这次 checkpoint，下一次 `drive` 在钩子返回字符串之前不会重发已经结算的 `streamSimple`。工具轮、terminate、摘要和 navigation 不调用它。terminate 不会因此再请求模型。`HarnessTool`、`ToolContext`、`ToolResult`、`HarnessMessage` 仍由 Durable 自己定义，不与 Agent 的同名类型合并。工具重放策略保存在操作状态中。

`Storage` / `StorageView` 是结构化接口。后端可以自行实现，无需继承 `MemoryStorage`。`run` 串行持有写入通道；其中每次 `apply` 分别原子提交，不跨多个 `apply` 回滚。借出的 view 数据应只读，写入时将 payload 的所有权交给存储。`apply` 在所属回调结束后失效。

## 原子结算与恢复

一条 lane 同时最多一个操作。完整操作状态保存在叶子中，恢复时读取它。响应、usage、tip 与阶段转移或操作终态在一次 `apply` 中提交。模型响应和摘要使用发送前预留的 entry ID。

- 未结算的模型流用已存帧生成 `aborted` 响应，不重发请求。帧按内容块序号还原文本、思考和已结束的工具调用；思考帧可以带上收到它的 completions 字段。恢复时仍去掉工具调用，未结束的工具调用没有帧，所以都不会执行。思考片段留在这条 aborted 消息上。帧或响应结算写入失败时，先等待已接受的帧写入收尾，再清理本进程的运行标记；同一 harness 再次 `drive` 也走中断恢复，不重发普通请求或摘要。
- `replay: "never"` 的未结算工具不重跑，结果保留最后一次 checkpoint。
- `replay: "safe"` 的工具使用持久化参数重跑。
- 并行工具完成后，entry 按 assistant 中的源顺序写入。

未结算状态的预留 entry / usage ID 必须尚未被占用。不一致的持久化状态直接报错，不尝试补写阶段或猜测归属。复制尾段的预留 ID 同样不能已经被占用。仓库处于初始开发阶段，不提供旧包入口别名、旧数据转换或旧格式修补分支。

## 上下文预算与压缩

`compaction.maxTokens` 是自动压缩的输入 token 阈值，不是这一次生成的输出上限。`HarnessOptions.maxTokens` 传给普通 `streamSimple`。摘要请求使用自己的输出上限，`tools` 为空，`thinkingLevel` 为 `off`。

`compaction.enabled` 同时控制阈值压缩和超限恢复。关闭时这两类明确失败；显式 compaction 和带 `summarize` 的 navigation 仍可执行。每个 operation 最多做一次超限恢复压缩。普通暂时错误仍按 `maxAttempts` 重试，超限不原样重试。

阈值受模型窗口、输出预留和安全余量约束。大窗口预留 4,096，小窗口预留窗口的 1/16 且至少 32。保留尾段最多 8,192，小窗口按窗口的 1/8 缩放且至少 64，同时不超过有效阈值的一半。摘要输出上限约为预留的一半，且不超过模型输出上限。

选择使用当前模型看得见的上下文：从最近一次 compaction 开始，跳过 `error`、`aborted`、`deferred` assistant。工具调用和配套结果整组移动。末尾还没回答的用户消息保留原文。更早的轮次可以进入摘要，一条很早的用户消息不会把它后面的历史全部钉住。已有摘要会写进下一次摘要，而不是在新摘要旁边再叠一条前缀。没有旧内容时结果是 `nothing to compact`。当前输入、系统提示词和工具定义已经放不下时直接失败，不截断当前输入，也不删掉工具定义。

摘要不用普通请求的 messages 和 tools。系统提示词是摘要指令，旧会话串成一条 user 消息，原来的系统指令只作为待摘要文本。角色标成 User、Assistant、ToolCall、ToolResult。图片只留下 `[Image attachment]`，不写入图片数据，也不表示模型看见了图片。旧内容放不下时先缩短旧工具输出，再缩短其他旧文本，保留首尾和 `[truncated]`，不改原始条目。缩到无法构成请求就失败，原分支保持。只调用一次摘要，不重试，也不做多级摘要。

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

本次对齐覆盖独立运行时、能力接口、平台适配器入口与契约检查。保留 lane 设计；没有引入 Pi 的 Conversation / Task / Chord、deferred、模型请求重发或摘要崩溃重试。JSONL 适配器延续单写入者设计；原子性指一条完整记录的提交与恢复，不提供多进程协调或断电后的 fsync 保证。
