# Durable 单内核迁移

本文件是 `@amazme/durable` 成为唯一执行内核的实施账本。它记录已经落地的入口、仍未切换的契约和移除旧内核前必须满足的条件。状态以源码与实际验证为准，不把计划写成已完成。

## 目标与不变量

- **一个持久状态**：会话、任务、排队输入和工具结果只由 Durable 的 SQLite（或调用方显式选择的 MemoryStorage）持有。
- **一个执行语义**：排队、steer、取消、压缩、重试和工具重放只有一份实现。旧 `AgentSession` 在迁移期间只接收兼容修复，不接收新能力。
- **单向迁移**：JSONL 只作为导入源和只读导出视图存在；不恢复双向镜像，不把 Durable 提交再写回 JSONL 作为第二权威。
- **不假装等价**：无法由 Durable 承载的 JSONL 语义（分支树、`parentSession`、部分扩展 UI）在导入报告或入口诊断中明确列出，不静默丢弃。
- **入口可以选择，语义不能分叉**：迁移开关只选择运行时，不改变模型、工具、提示和权限的含义。

## 阶段状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 冻结旧内核：新能力只进 Durable，旧 SDK 标记为兼容路径 | 已完成政策与注释；尚无自动增长检查 |
| 1 | print / JSON / RPC 切到 Durable | print 文本与 JSON 已完成（`AMAZME_RUNTIME=durable`）；RPC 未切换；默认仍为旧内核 |
| 2 | SDK 的 `createAgentSession` 迁到 Durable 后端 | 未开始；需要兼容 facade 和扩展 UI 方案 |
| 3 | JSONL 一次性导入与只读导出 | 导入已完成（`amazme import`）；导出/分享仍走 JSONL |
| 4 | 删除旧 `AgentSession`、JSONL、镜像和重复实现 | 未开始；受下方移除门槛约束 |

### 阶段 0：冻结

- 新增能力进入 `src/durable/`、`packages/durable/` 或共享纯模块，不再加在 `core/agent-session.ts` 上。
- `createAgentSession` 的文档注释标记为迁移期兼容入口。
- 旧路径的缺陷仍修，但不以“两条路径都支持”为默认交付标准。

### 阶段 1：无头入口

已落地：

- `AMAZME_RUNTIME=durable` 让 `--print` 文本和 `--mode json` 使用 Durable Harness。
- 输入由 `submitAndWait()` 自己等待 receipt，再从已提交的 transcript 读回答案，不依赖视图刷新时序。
- JSON 流保持既有事件名（`agent_start`、`message_start`、`message_update`、`message_end`、工具与压缩事件），并新增 `storage: "durable"` 会话头；这是展示协议，不是新的持久格式。
- `--no-session` 使用 MemoryStorage；`--session-dir`、`--continue`、`--name`、模型/推理/凭据、工具选择、资源、MCP 与原生 facet 继续沿用 Durable 路径。
- 不支持的旧 JSONL 标志（`--session`、`--session-id`、`--fork`）和 SDK 内联扩展工厂在打开存储前明确拒绝，避免静默换语义。

未落地：

- RPC 仍在旧 `AgentSession` 上。RPC 的扩展 UI、会话切换、导出和命令表需要逐项映射，不能用 print 适配层冒充。
- 默认运行时尚未切换。等 RPC 与 SDK 兼容层完成、真实入口验收通过后再改默认值。

### 阶段 2：SDK 兼容层

`createAgentSession` 仍是公开 SDK，内部仍用 `AgentSession` 与 JSONL。直接替换会破坏 `prompt()`/事件/`ctx.ui`/`SessionManager` 契约。需要先提供 Durable 后端 facade，覆盖常用 API 与事件，再标记旧实现只读兼容；扩展 UI 通过宿主服务而不是伪造 Durable 事件。

### 阶段 3：导入与导出

已落地：

- `amazme import <session.jsonl> [--session-dir <dir>]` 把一条终端 JSONL 导入新的 Durable 会话。
- 读取使用与宿主 handoff 相同的投影；可承载的消息和压缩摘要写入 Durable，`model_change` 等记录计入报告。
- JSONL 文件不被修改；导入失败删除本次创建的会话目录。

未落地：

- Durable 会话导出 HTML / 分享、以及 JSONL 只读导出命令。
- 批量迁移、重复导入检测和回滚快照。

### 阶段 4：移除门槛

只有同时满足以下条件才删除旧内核：

1. print、JSON、RPC 和 SDK 都有 Durable 实现，且真实入口验收通过。
2. 导入覆盖现有用户会话，无法导入的分支与 metadata 有明确处置和回滚方式。
3. 扩展 UI、`/share`、HTML 导出等旧能力有 Durable 等价物或产品决定下线。
4. Durable 至少一个 minor 没有破坏持久任务/存储格式，或本仓库有固定 pin 与自动迁移。
5. 旧内核的测试面已迁到 Durable，删除后不出现未覆盖的行为。

## 验证

修改后逐包构建和测试，不跑根全量：

```bash
npm run build --workspace @amazme/coding-agent
npx vitest --run test/durable-print.test.ts test/durable-import.test.ts
```

真实入口（需要本机模型凭据或本地 faux 服务）：

```bash
AMAZME_RUNTIME=durable amazme --print "只回复 ok"
AMAZME_RUNTIME=durable amazme --mode json "只回复 ok"
amazme import ./session.jsonl --session-dir ./agent-history
```

`--no-session` 与 `--continue` 互斥；`AMAZME_RUNTIME` 只接受 `durable` 或 `legacy`。
