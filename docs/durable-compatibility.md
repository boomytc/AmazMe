# Durable 兼容债

本文件记录 Durable 成为唯一内核之后，旧 JSONL 契约的处置。判断标准是：入口是否真的走 Durable，无法承载的语义是否明确拒绝。

## 已关闭

| 债务 | 处理 | 边界 |
| --- | --- | --- |
| RPC `new_session` | 在当前会话 cwd 新开一个 Durable 会话，切走前中止旧运行并释放旧锁 | `parentSession` 不伪装；传入时明确报错 |
| RPC `switch_session` | 接受 Durable 会话目录、`session.sqlite` 或 JSONL；JSONL 先单向导入再切换 | JSONL 不写回；同一路径是 no-op；导入产生新的 Durable 会话 |
| RPC `get_entries` / `get_tree` | 把活动 Durable transcript 投影成 JSONL 形状 | 是视图，不是第二份持久树 |
| RPC `fork` | 接收投影 ID 或原始 Durable ID，返回被选中的用户文本 | 分支仍由 Durable conversation 承载 |
| RPC `abort_retry` | 从协议、客户端和 RPC 处理里删除 | 旧客户端收到未知命令错误；没有新增只取消退避的 API |
| `createAgentSession` / `SessionManager` / 内联扩展工厂 | 删除。SDK 只保留 `createDurableSession` | 插件只通过原生 facet。只演示旧 `ExtensionAPI` 的五个示例目录已删除 |
| `--session` / `--session-id` / `--new-session-id` / `--fork` | 原生 `--session` 精确打开已有 Durable 会话；宿主 `--session-id` 只打开已有会话，`--new-session-id` 用指定 ID 创建；`--fork` 仍为未知选项 | 分叉使用 `/tree` 和 `/fork`。导入和导出使用 `amazme import` / `amazme export` |
| 只有 JSONL 历史的 `--continue` | 不回退旧内核。若扫描到旧 JSONL，提示先 `amazme import` | 扫描的是旧 sessions 目录，不读取 Durable 存储 |
| 旧 `AgentSession` / JSONL 内核 / 宿主镜像 | 删除 | JSONL 类型留在 `jsonl-transcript.ts`，只服务导入、导出和投影 |
| `/share` | 原生终端复用 `writeDurableExport` 和 `shareFilesToUrl` | 目的地仍是设置里的 Radius 或私有 gist |

RPC 会话生命周期由 `createDurableRpcSessionControl()` 提供，`runDurableRpc()` 负责停止旧事件流、重绑 handler、关闭旧会话。

## 有意不做

| 事项 | 原因 |
| --- | --- |
| 把 `createAgentSession` 适配成 Durable | 公开契约不同。调用方改用 `createDurableSession` |
| 导入 JSONL 分支或 `parentSession` | `amazme import` 保持单向活动转录。分支树和父会话会被拒绝 |
| 恢复 JSONL 写回或宿主镜像 | Durable SQLite 是唯一权威 |
| 在 `packages/durable` 增加 cancel-retry | `abort_retry` 的语义无法无损映射，产品选择删除该命令 |
| 改 Durable 存储格式 | 已有会话必须还能用 `--continue` 打开 |

## 验证

```bash
npm run build --workspace @amazme/coding-agent
npm test --workspace @amazme/coding-agent
npm run typecheck
```
