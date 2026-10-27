# Python SDK 示例

现行会话 SDK 是 `amazme_backend.sdk.Client`，连接已有 Python Host。旧 `createDurableSession`、TS 内联扩展和模型运行时已移除；不读取旧 auth/settings/JSONL。

- [session.py](session.py)：显式绑定 Host、会话、工作区、请求 ID；提交前核对工作区，未知回执只查询原 ID。
- [plugin.py](plugin.py)：真实 Python factory 和 Pydantic 参数模型，由现有会话插件服务加载。

```bash
backend/.venv/bin/python backend/examples/sdk/session.py \
  --url http://127.0.0.1:PORT --token-file /absolute/profile/web.token \
  --session SESSION_ID --workspace primary --request REQUEST_ID --prompt 'Read the project instructions'
```

省略 `--prompt` 查询原请求；示例不会自动给 unknown 换 ID。审批通过 `await_user_decision` / `decide`，取消通过 `cancel`；取消受理与执行资源退出分开核对。

模型与凭据分别调用 `update_model` / `update_account`，OAuth 使用 `start_oauth` / `oauth` / `oauth_input`。工具范围、系统提示词、追加提示词属于 `submit` 请求并进入同 ID 核对。项目指令、技能和模板沿现行 Python 资源入口读取，不再接受已失效的 TS 构造器选项。

插件、stdio MCP、PTY、Codemode、computer-use、检查点和产物均使用同一 Client；实际签名和数据结构见 [SDK](../../docs/sdk.md) 与 [Python 契约](../../../docs/python-backend-plan.md)。独立图片定位示例见 `locate-image.py`，显式使用当前目录中的 `typesafe/jev-latest`，由账号模块解析认证，再调用中立分类接口与原有裁剪、置信度逻辑；运行它会调用指定 profile 的真实分类账号。
