# RPC 入口

`--mode rpc` 把 stdio 当成 JSON-RPC 2.0 通道，连接同一个 Python Host、会话、审批和副作用账本，不开第二套业务运行时。

```bash
node packages/coding-agent/dist/bundle/cli.js --mode rpc \
  --python-url http://127.0.0.1:PORT --python-token '配对码'
```

包的 `rpc-entry` 导出（`dist/bundle/rpc-entry.js`）等价于 `--mode rpc`。

- 每行一个请求 `{"jsonrpc":"2.0","id":...,"method":...,"params":{...}}`，每行一个响应。
- `request.submit` 会把 `--model`、`--thinking`、资源和工具范围等本次运行选项并入 `params`；其他方法原样转发给 Host。
- 默认不建立 attachment。带 `--extensions` 且给出 `--session` 时，CLI 先附着会话、加载插件，stdin 结束后释放 binding；RPC 方法需要的 `session_id`、`attachment_id` 由 `params` 携带，后端按原绑定规则校验。
- 请求解析或传输失败时，CLI 返回 `{"code":-32700,"message":"<错误码>"}`；Host 的业务错误由后端返回 `{"code":-32000,"message":"<原错误码>"}`，CLI 原样转发。
- stdin 结束时进程以 0 退出；待审批状态出现在响应里，不作为退出码。

Python SDK、账号和插件入口见[后端 SDK 文档](../../../backend/docs/sdk.md)，业务契约见[Python 方案](../../../docs/python-backend-plan.md)。
