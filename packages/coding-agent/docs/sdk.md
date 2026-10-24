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

模型选择 `models` / `update_model` 与账号 `accounts` / `update_account` 分离；OAuth 使用 `start_oauth` / `oauth` / `oauth_input` / `cancel_oauth`，沿用原供应商身份。不要通过模型配置传递密钥。

其他入口包括 `register_plugin/reload_plugin/call_plugin/cancel_plugin/close_plugin`、`code_tools/run_code/cancel_code`、stdio MCP、会话 PTY、computer-use、检查点、产物和导入导出；参数直接来自 `amazme_backend.contracts`，不保留另一套 SDK 业务状态。

可运行示例见 [examples/sdk](../examples/sdk/README.md)。完整业务契约与运行边界统一见 [Python 方案](../../../docs/python-backend-plan.md)，源码签名见 `backend/src/amazme_backend/sdk.py`。
