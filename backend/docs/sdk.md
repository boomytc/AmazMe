# Python SDK

`amazme_backend.sdk.Client` 连接已有的本机 Python Host。CLI、Web/Electron、TUI、RPC 与 SDK 共用 Host、会话、审批、账号及副作用账本。Node 包不再导出 `createDurableSession` 或 `@amazme/coding-agent/durable`。

```python
from pathlib import Path
from amazme_backend.sdk import Client

async with Client('http://127.0.0.1:PORT', Path('/absolute/profile/web.token').read_text()) as client:
    session = await client.create_session(title='SDK', workspace='primary')
    attachment = await client.attach(session.session_id)
    # Store session_id and request_id before sending. Retrying uses these exact IDs and payload.
    receipt = await client.submit(session_id=session.session_id, workspace=session.workspace,
        attachment_id=attachment.attachment_id, request_id='user-chosen-id', text='Read README.md',
        allowed_tools=['read_file'])
```

每次写操作绑定当前 Host 构建、代际以及需要的会话 attachment。Client 建立连接时 bootstrap；跨代际后重新连接并查询原请求，不能把旧请求改成新 ID 自动重发。

`request` 查询原回执；`wait` 只轮询原 ID。`await_user_decision` 返回待审批项或终态，`decide` 绑定原 proposal digest 和 revision。`cancel` 表示取消请求已处理；是否退出应结合 snapshot、健康状态和原资源清理证明。`unknown` 需要明确核对，不是可自动重试的失败。

`submit` 支持系统提示词、追加提示词、工具白名单/排除项与图片；这些选项随请求持久化。`steer` 不改写原回合选项。`sessions`、`session`、`snapshot`、`session_usage` 提供持久会话、当前状态和实际已完成模型用量。

`session_usage` 汇总完整会话，包含子任务及保存了用量的压缩调用；`models` 按模型拆分，`recent` 只列最近 100 个主回合，上方总量不受该限制影响。输入总量为 `input_tokens + cache_read_tokens + cache_write_tokens`，缓存比例用总缓存读取除以总输入。`model_calls` 与 `attempted_model_calls` 分别是留有完成用量和已发起的调用，失败但没有完成用量的调用不补造 token。费用使用调用时保存的目录单价，未知单价或无用量的旧压缩使完整费用保持未知。重复压缩回执按原调用身份去重。

`model_ms`、`tool_ms` 汇总步骤发起至回执的本地耗时，并发区间可以重叠；对应 `timed_*_calls` 是测量覆盖数。`first_text_ms / first_text_calls` 表示首段文本的平均等待，以持久预览到达为准。旧步骤没有时间记录时不回填零。压缩只有已保存的完成回执参与统计，未能提交的摘要调用不在该统计范围内。

模型选择 `models` / `update_model` 与账号 `accounts` / `update_account` 分离；OAuth 使用 `start_oauth` / `oauth` / `oauth_input` / `cancel_oauth`，沿用原供应商身份。不要通过模型配置传递密钥。

`save_schedule(ScheduleInput(...))` 的 `target` 可选 `SessionScheduleTarget(kind="session", session_id=...)`，或 `NewSessionScheduleTarget(kind="new_session", workspace="primary", title="定时检查", model_selection=...)`。后者每次执行创建独立会话，可选 `project_id`；省略模型选择时使用执行时的 Host 默认模型。旧版 `session_id` 输入和持久计划仍可读取。`run_schedule` 的操作编号重复使用时查询原次运行，不创建新会话；`pending` 和 `history` 都带实际运行的 `session_id`。运行中的会话需先取消该次排程并等待清理，才能删除。任务不重叠执行，Host 同时最多接纳四个排程；达到会话容量时暂停任务并留下未接纳记录，历史会话由用户显式管理。

其他入口包括 `register_plugin/reload_plugin/call_plugin/cancel_plugin/close_plugin`、`code_tools/run_code/cancel_code`、stdio MCP、会话 PTY、检查点、产物和导入导出；参数直接来自 `amazme_backend.contracts`，不保留另一套 SDK 业务状态。

`read_file(path, offset=0, limit=32000)` 对应 `GET /api/v1/files/content` 的字节分页，`limit` 为 4–32000。下一页使用返回的 `next_offset`，不要按字符串长度计算；游标必须落在 UTF-8 字符边界。`has_more` 表示是否还有内容，连续读取时比较 `digest`，避免拼接不同版本。

模型提出结构化问题后，`wait_for_question(session_id=..., request_id=...)` 返回持久 `QuestionView`；`answer_question(session_id=..., attachment_id=..., value=QuestionAnswer(...))` 提交显式回答。把当前 view 的问题编号、请求编号、摘要和代次带入 DTO，`answers` 使用 `UserAnswer(id=..., selected=[...], custom=...)`，每题都须有选择或非空文字。跳过用 `kind="skipped"` 且不带回答。重试复用 `decision_id` 和全部内容；Host 重开后重新读问题，旧代次会被拒绝。`await_user_decision` 在 `waiting_input` 时返回回执及 `None`，调用方据此读取问题，不能把它当作请求完成。

可运行示例见 [examples/sdk](../examples/sdk/README.md)。完整业务契约与运行边界统一见 [Python 方案](../../docs/python-backend-plan.md)，源码签名见 `src/amazme_backend/sdk/client.py`。

SDK 只加载 HTTP 客户端和轻量数据契约；导入不会进入 Host、会话存储、监督器或供应商实现。后端按业务所有权划分，入口、公开模块与依赖方向见 [后端架构](../ARCHITECTURE.md)。

`Client.model_scope(patterns, provider=...)` 使用 Python 的候选解析。
`submit(..., model_selection=ModelSelection(provider=..., model=...))` 可固定本次模型；省略时使用会话选择。
Host 投递、worker 接纳与子任务保存同一公开模型配置，凭据仍只在实际请求前从原账号库解析。
