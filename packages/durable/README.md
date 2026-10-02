# @amazme/durable

独立于内存 Agent 的持久化 lane 运行时，直接依赖 `@amazme/ai` 和 `@amazme/telemetry`。包边界参考 [Pi `7fbbd5f`](https://github.com/earendil-works/pi/blob/7fbbd5f4a1d982bb02d63472dde0774fa639f99b/packages/durable/package.json)，运行语义保持本仓库现有设计。

## 入口与使用

```typescript
import { createModels, fauxProvider } from "@amazme/ai";
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

核心入口和内存后端可在没有 Node 模块、全局 `process`、Agent 包或业务客户端的环境中使用。需要持久化文件时显式导入 Node 适配器：

```typescript
import { JsonlStorage } from "@amazme/durable/storage/jsonl/node";
const storage = new JsonlStorage("./state/lane.jsonl");
```

## 依赖与能力契约

`HarnessModels` 只要求 `getModel`、`streamSimple` 和可选的 `telemetryContext`，无需继承 `Models` 或提供认证存储、目录修改等额外能力。`createModels()` 返回的对象直接满足接口。

`HarnessTool`、`ToolContext`、`ToolResult`、`HarnessMessage` 由 Durable 自己定义。工具和消息按结构满足各运行时自己的契约；Durable 的源码与声明不依赖 Agent。工具重放策略保存在操作状态中。

`Storage` / `StorageView` 是结构化接口。后端可以自行实现，无需继承 `MemoryStorage`。`run` 串行持有写入通道；其中每次 `apply` 分别原子提交，不跨多个 `apply` 回滚。借出的 view 数据应只读，写入时将 payload 的所有权交给存储。`apply` 在所属回调结束后失效。

## 原子结算与恢复

一条 lane 同时最多一个操作。完整操作状态保存在叶子中，恢复时读取它。响应、usage、tip 与阶段转移或操作终态在一次 `apply` 中提交。模型响应和摘要使用发送前预留的 entry ID。

- 未结算的模型流用已存帧生成 `aborted` 响应，不重发请求。
- `replay: "never"` 的未结算工具不重跑，结果保留最后一次 checkpoint。
- `replay: "safe"` 的工具使用持久化参数重跑。
- 并行工具完成后，entry 按 assistant 中的源顺序写入。

未结算状态的预留 entry / usage ID 必须尚未被占用。不一致的持久化状态直接报错，不尝试补写阶段或猜测归属。仓库处于初始开发阶段，不提供旧包入口别名、旧数据转换或旧格式修补分支。

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
