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
| 1 | print / JSON / RPC 切到 Durable | 新建无头会话默认 Durable；print/JSON/RPC 核心命令已通；JSONL 专用标志、SDK 扩展工厂和只有 JSONL 历史的 `--continue` 回退旧内核 |
| 2 | SDK 的 `createAgentSession` 迁到 Durable 后端 | 实验性 `DurableSession` facade 已加入；`createAgentSession` 未切换 |
| 3 | JSONL 一次性导入与只读导出 | 导入与 Durable 会话导出已完成；分享仍走 JSONL/HTML 产物 |
| 4 | 删除旧 `AgentSession`、JSONL、镜像和重复实现 | 未开始；受下方移除门槛约束 |

### 阶段 0：冻结

- 新增能力进入 `src/durable/`、`packages/durable/` 或共享纯模块，不再加在 `core/agent-session.ts` 上。
- `createAgentSession` 的文档注释标记为迁移期兼容入口。
- 旧路径的缺陷仍修，但不以“两条路径都支持”为默认交付标准。

### 阶段 1：无头入口

已落地：

- 新建无头会话默认使用 Durable Harness：`--print` 文本、`--mode json` 和 `--mode rpc`。
- `AMAZME_RUNTIME=legacy` 显式回到 JSONL 内核；`--session`、`--session-id`、`--fork`、内联 SDK 扩展工厂，以及只有 JSONL 历史的 `--continue` 自动回退。显式 `AMAZME_RUNTIME=durable` 遇到这些选项时明确拒绝。
- 输入由 `submitAndWait()` 自己等待 receipt，再从已提交的 transcript 读回答案，不依赖视图刷新时序。
- JSON 流保持既有事件名（`agent_start`、`message_start`、`message_update`、`message_end`、工具与压缩事件），并新增 `storage: "durable"` 会话头；这是展示协议，不是新的持久格式。
- `--no-session` 使用 MemoryStorage；`--session-dir`、`--continue`、`--name`、模型/推理/凭据、工具选择、资源、MCP 与原生 facet 继续沿用 Durable 路径。
- 不支持的旧 JSONL 标志（`--session`、`--session-id`、`--fork`）和 SDK 内联扩展工厂在打开存储前明确拒绝，避免静默换语义。
- RPC 的 Durable 路径支持 `prompt`、`steer`、`follow_up`、`abort`、`clear_queue`、`fork`、`clone`、`get_state`、`get_messages`、`get_last_assistant_text`、模型/推理选择、`get_session_stats`、`set_session_name`、`set_steering_mode`、`set_follow_up_mode`、`set_auto_compaction`、`compact`、`get_entries`、`get_tree`、`get_fork_messages`、`bash`、`abort_bash`、`set_auto_retry`、`export_html`、`get_commands`。事件沿用 RPC 事件名。
- RPC 中依赖 JSONL 树切换、扩展 UI 或独立重试控制的命令（`new_session`、`switch_session`、`fork`、`clone`、`bash`、`compact`、`clear_queue`、`get_entries`、`get_tree`、`export_html` 等）返回明确的 unsupported 错误，不伪造结果。

未落地：

- RPC 的 JSONL 专用命令尚未映射。它们依赖终端树、扩展 UI 或 JSONL 导出语义，需要单独设计 Durable 等价物。
- JSONL 专用 RPC 命令和 SDK 扩展工厂没有 Durable 等价物，因此旧内核仍作为兼容回退保留。

### 阶段 2：SDK 兼容层

已落地：

- `@amazme/coding-agent/durable` 导出实验性 `createDurableSession()` 与 `DurableSession`。它覆盖 prompt、steer、followUp、abort、compact、模型/推理选择、活动上下文消息和 Durable 事件订阅，直接返回已提交的答案。
- 该 facade 不创建 JSONL 会话，不伪装扩展 UI，也不返回 `AgentSession` 或 `SessionManager`；需要这些契约的调用方继续使用 `createAgentSession`。

未落地：

- `createAgentSession` 仍未切换。直接替换会破坏 `prompt()`/事件/`ctx.ui`/`SessionManager` 契约；需要先完成兼容 facade 和扩展 UI 方案，再标记旧实现只读兼容。

### 阶段 3：导入与导出

已落地：

- `amazme import <session.jsonl> [--session-dir <dir>]` 把一条终端 JSONL 导入新的 Durable 会话。
- 读取使用与宿主 handoff 相同的投影；可承载的消息和压缩摘要写入 Durable，`model_change` 等记录计入报告。
- JSONL 文件不被修改；导入失败删除本次创建的会话目录。
- `amazme export <session.sqlite|session-dir> [output]` 把 Durable 会话的活动 transcript 导出为 JSONL 或 HTML。导出读取数据库副本，不打开或迁移源库；分支历史仍保留在源库中。

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
