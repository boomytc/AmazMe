# Durable 单内核迁移

本文件是 `@amazme/durable` 成为唯一执行内核的实施账本。状态以源码为准。

## 当前产品策略

- Durable 是唯一运行时。原生终端、Web/宿主、`--print`、`--mode json`、`--mode rpc` 和进程内 SDK 都打开 Durable 会话。
- 没有 `AMAZME_RUNTIME`，也没有 JSONL 内核回退。`--session`、`--session-id`、`--fork` 是未知选项。分叉使用 Durable 已有的 `/tree` 和 `/fork`。
- `--continue` 和 `--resume` 只恢复当前目录下最新的 Durable 会话。磁盘上若只剩旧 JSONL，命令打印明确提示，要求先运行 `amazme import <session.jsonl>`。这是诊断扫描，不是第二套运行时。
- SDK 只导出 `createDurableSession`。插件只走原生 facet。`createAgentSession`、`SessionManager` 和内联 SDK 扩展工厂已删除。
- RPC 不再有 `abort_retry`。旧客户端会收到未知命令错误。Durable 包里没有新增只取消退避的 API。
- JSONL 只作为导入源、`amazme export` 和 RPC `get_entries`/`get_tree` 的只读投影。条目类型在 `jsonl-transcript.ts`，其中没有 `SessionManager`。
- `amazme import` 仍是单向导入活动转录。不导入分支，不导入 `parentSession`。带父会话或分支树的文件会被拒绝。
- Durable 会话目录和 SQLite 格式没有改动。默认根仍是 `~/.amazme/agent/experimental/durable-sessions/<cwd 哈希>`；`--session-dir` 仍覆盖这个根。
- 原生终端的 `/share` 复用 `writeDurableExport` 和 `shareFilesToUrl`，目的地来自 `SettingsManager.getSessionShareDestination()`。

## 目标与不变量

- **一个持久状态**：会话、任务、排队输入和工具结果只由 Durable 的 SQLite（或调用方显式选择的 MemoryStorage）持有。
- **一个执行语义**：排队、steer、取消、压缩、重试和工具重放只有 Durable 一份实现。
- **单向迁移**：JSONL 只作为导入源和只读导出视图存在；不恢复双向镜像，不把 Durable 提交再写回 JSONL 作为第二权威。
- **不假装等价**：无法由 Durable 承载的 JSONL 语义（分支树、`parentSession`）在导入时明确拒绝。

## 阶段状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 冻结旧内核：新能力只进 Durable | 已完成 |
| 1 | print / JSON / RPC 切到 Durable | 已完成；这些入口不再回退 JSONL |
| 2 | SDK 只保留 Durable API | 已完成；公开入口是 `createDurableSession` |
| 3 | JSONL 一次性导入与只读导出 | 已完成；导入只接受线性活动转录 |
| 4 | 删除旧 `AgentSession`、JSONL 内核、镜像和重复实现 | 已完成 |

### 阶段 4 删除了什么

- `AgentSession`、`SessionManager`、`createAgentSession`、交互模式的 JSONL TUI、print/RPC 的 JSONL 入口，以及宿主 JSONL 镜像和 handoff。
- `AMAZME_RUNTIME`。
- RPC `abort_retry`。没有占位错误，也没有在 `packages/durable` 增加替代命令。
- 只演示已删除 `ExtensionAPI` 的五个示例目录已删除：`with-deps`、`custom-provider-anthropic`、`custom-provider-gitlab-duo`、`sandbox`、`gondolin`。SDK 示例改为 `createDurableSession`。
- 只覆盖旧内核的测试已删除。仍存在的行为（参数解析、会话目录诊断、分享文件上传、模型选择界面、设置界面）留在 Durable 或纯函数测试里。

### 阶段 4 保留了什么

- `jsonl-transcript.ts` 里的条目类型和解析，供导入、导出和 RPC 投影使用。
- `amazme import` 的现有限制：version 必须是 3，且转录必须是线性的。
- Durable 存储布局。已有 Durable 会话应能用 `--continue` 接着打开。评审人 Boom 会在自己的机器上确认这一点。

## 验证

```bash
npm run build --workspace @amazme/coding-agent
npm test --workspace @amazme/coding-agent
npm run typecheck
```

真实入口可以使用 faux 供应商：

```bash
amazme --print "只回复 ok"
amazme --mode json "只回复 ok"
amazme --mode rpc --no-session
amazme import ./session.jsonl
amazme --continue
```

`--no-session` 与 `--continue` 或 `--resume` 互斥。未知选项在打开存储前退出。
