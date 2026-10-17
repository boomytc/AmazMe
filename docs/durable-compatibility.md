# Durable 兼容债

本文件记录 Durable-first 之后仍未闭合的兼容面，以及已经用 Durable 语义实现的替代方案。判断标准只有两个：产品入口是否真的可用，无法承载的语义是否明确报错。

## 已关闭

| 债务 | 处理 | 边界 |
| --- | --- | --- |
| RPC `new_session` | 在当前会话 cwd 新开一个 Durable 会话，切走前中止旧运行并释放旧锁 | `parentSession` 不伪装；Durable 没有 JSONL 父子会话链接，传入时明确报错 |
| RPC `switch_session` | 接受 Durable 会话目录、`session.sqlite` 或 JSONL；JSONL 先单向导入再切换 | 打开目录时从 `amazme.agent` 恢复项目 cwd；JSONL 不写回；同一路径是 no-op；导入会产生新的 Durable 会话 |
| RPC `get_entries` / `get_tree` | 把活动 Durable transcript 投影成 JSONL 形状 | 是视图，不是第二份持久树；`since` 和 `leafId` 使用投影 ID |
| RPC `fork` | 接收投影 ID 或原始 Durable ID，返回被选中的用户文本 | 分支仍由 Durable conversation 承载，不生成 JSONL fork |
| RPC `sessionFile` / `get_session_stats.sessionFile` | 返回 `session.sqlite` 路径 | 内存会话仍为 `undefined` |
| RPC `set_session_name` | trim 后拒绝空名称 | 与旧 RPC 一致 |
| RPC `bash` / `abort_bash` | 在会话 cwd 本地执行并支持取消 | 不写入 Durable transcript，也不触发扩展 `user_bash` 钩子 |
| `amazme export` | 从 SQLite 副本导出 JSONL/HTML | 导出的是活动 transcript；分支历史仍在源库 |

RPC 会话生命周期由 `createDurableRpcSessionControl()` 提供，`runDurableRpc()` 负责停止旧事件流、重绑 handler、关闭旧会话。直接调用 `createDurableRpcHandler(durable)` 而不传 control 时，`new_session` / `switch_session` 仍会明确返回 unsupported，这是内部 API 的保守默认。

## 有意保留

| 债务 | 为什么不现在关闭 | 后续触发条件 |
| --- | --- | --- |
| `createAgentSession` 仍走 JSONL | 它公开返回 `AgentSession`、`SessionManager`、扩展 `ctx.ui` 和 JSONL 文件语义；换成 Durable 不是换存储，而是换公开契约 | 先有 `AgentSession` 兼容 adapter，或决定发布 `createDurableSession` 作为唯一新 SDK 并进入弃用周期 |
| 内联 SDK 扩展工厂 / `ctx.ui` | Durable 有插件 facet，但没有与旧扩展 UI 等价的事件桥；在 headless 里伪造 UI 会让扩展以为交互可用 | 明确 headless 扩展 UI 的语义（拒绝、降级或宿主代理）后再接 |
| `--session` / `--session-id` / `--fork` | 这些标志要求继续写回同一 JSONL 或操作 JSONL 分支树；Durable 是单向导入，不能伪装成同一文件 | 提供显式导入/导出工作流，或让这些标志只作为导入入口并改文档 |
| 只有 JSONL 历史的 `--continue` | 自动导入会在用户不知情时创建第二份历史；目前回退 legacy 更诚实 | 增加显式的“导入后继续”开关，或完成一次性迁移工具 |
| RPC `abort_retry` | Durable 的重试是 generation task 的 checkpoint；没有“只取消退避、保留本轮”的 API，调用 `abort()` 会扩大到整轮 | 上游提供 retry-only cancel，或产品接受“取消本轮”作为语义并改名 |
| 旧 `AgentSession` / JSONL 内核 | 仍承载上述兼容面；删除会直接造成功能缺失 | `docs/durable-migration.md` 的阶段 4 门槛全部满足 |

## 处理顺序

1. **P0 兼容正确性**：RPC 投影 ID 与 `fork` 映射、`switch_session` 锁释放、JSONL 导入失败回滚。已有测试覆盖投影、会话选择和切换决策。
2. **P1 产品闭环**：真实入口跑一次 `new_session` / `switch_session` / `export_html`，确认事件流重绑和旧会话关闭没有泄漏。
3. **P2 兼容层设计**：`createAgentSession` 与 `ctx.ui` 的 adapter，或正式弃用旧 SDK；这是阶段 4 的前置条件。
4. **P3 JSONL 迁移体验**：显式导入、重复检测、批量迁移；不要恢复双向镜像。

## 验证

```bash
npm run build --workspace @amazme/coding-agent
npx vitest --run test/durable-rpc.test.ts test/durable-rpc-session.test.ts test/durable-sessions.test.ts
npm test --workspace @amazme/coding-agent
npm run check:workspace
```
