# RPC 入口

`--mode rpc` 把 stdio 当成 JSON-RPC 2.0 通道，连接同一个 Python Host、会话、审批和副作用账本，不开第二套业务运行时。

```bash
node packages/coding-agent/dist/bundle/cli.js --mode rpc \
  --python-url http://127.0.0.1:PORT --python-token '配对码'
```

包的 `rpc-entry` 导出（`dist/bundle/rpc-entry.js`）等价于 `--mode rpc`。

- 每行一个请求 `{"jsonrpc":"2.0","id":...,"method":...,"params":{...}}`，每行一个响应。
- `request.submit` 会把 `--model`、`--thinking`、资源和工具范围等本次运行选项并入 `params`；其他方法原样转发给 Host。
- 需要 attachment 的写操作与 print 模式共用同一绑定和释放规则。进程退出只释放绑定，不取消已受理的工作。
- 请求解析失败返回 `-32700`；Host 错误码按原值返回。
- stdin 结束时进程以 0 退出；待审批状态出现在响应里，不作为退出码。

Python SDK、账号和插件入口见[后端 SDK 文档](../../../backend/docs/sdk.md)，业务契约见[Python 方案](../../../docs/python-backend-plan.md)。
