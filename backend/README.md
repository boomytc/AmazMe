# AmazMe Python 后端

AmazMe 按 [本机优先方案](../docs/python-backend-plan.md) 使用 Python shell、文件、PTY、MCP 操作用户真实环境。
保留 Python 会话、模型、SQLite、审批及客户端，移除 VM 默认执行依赖。状态见 [验收台账](../docs/python-backend-completion.md)。

Python SDK 入口是 `amazme_backend.sdk.Client`，说明见 [SDK](docs/sdk.md)，可运行示例在 [examples/sdk](examples/sdk/README.md)。

本机 shell 具有当前用户权限，文件 API 的路径检查和命令审批不构成操作系统沙箱。
不自动把后端令牌、模型密钥传给工具；继续保留签名、公证和系统权限要求。

本机 shell、文件、审批、检查点、PTY 和 stdio MCP 服务已接通 Web。用户可以连接服务、
选择工具、填写 JSON 参数并审批调用。已连接服务的工具目录也会交给模型；模型提出的调用走会话审批，
不能调用 Host 的用户审批接口代替决定，批准后的结果进入后续模型上下文。
动态目录刷新及媒体回传已有定向检查；HTTP/OAuth 等其他 MCP 传输不属于当前 stdio 主路径。
普通 shell 不用于声明长驻服务；开发服务器可在会话终端运行，
关闭页面不会停止终端，使用「关闭终端」或停止后端结束它。监督器失联后不自动重启命令。
终端协议窗口保持 32 KiB，监督器按已读输出归还信用。重连记录最多 256 KiB，页面解释光标、换行和清屏；直接按键与表单共用输入账本，接收输入不等于命令成功。Electron 装载这份页面；窗口关闭按桌面偏好处理，退出会停止它拥有的后端。`amazme-backend tui`、print/JSON CLI、`--mode rpc`、Python SDK 和默认 `amazme` 交互画面在同一会话上等待显式批准，并能操作终端、文件、检查点和本机 MCP；离开、松开绑定或进程退出不关闭这些服务。
`amazme-backend client submit` 返回终态或待审批项，待审批退出码为 2，并给出原提案编号；退出释放本次 attachment。
`client request --session ID --request-id ID` 查询原回执。`client decide` 必须单独给出「批准」或「拒绝」；请求审批还需 `--approval-id ID`，MCP 则指向原调用。
重试只核对原提案，不能批准后续工具；已经结算的决定只返回原请求状态。提交文本里的「批准」不是决定。
模型选择请求不携带密钥。更换或清除密钥走单独入口；过期代际不会覆盖新密钥，响应里也不出现密钥。
MCP 服务同样归属会话；停止服务后，未取得结果的调用保持 `unknown`，不能自动重试。

首次启动使用新的 profile、实际项目目录和权限为 0600 的供应商 JSON（`provider`、`model`、
`api_key`）；不要把该 JSON 放入仓库。`init` 复制配置后，原临时文件可删除。

```bash
backend/.venv/bin/python -m amazme_backend init --profile /absolute/new-profile --workspace /absolute/project --provider-config /private/provider.json
backend/.venv/bin/python -m amazme_backend serve --profile /absolute/new-profile
```

`serve` 输出回环 URL，浏览器直接打开即可，无需配对。页面自动设置本机连接 Cookie。
TUI、SDK 等客户端的连接令牌用 `pair --profile /absolute/new-profile` 取得；
退出用 `stop --profile /absolute/new-profile`，均通过同一模块命令运行。
默认修改操作需要审批。执行环境保留 PATH/HOME 等工具查找变量，不继承模型密钥和控制令牌。

开发采用 `confident-development-conventions`，从状态归属、类型与模块边界保证逻辑闭环。按本次改动选择必要检查：

```bash
uv sync --project backend --frozen
backend/.venv/bin/ruff check backend/src backend/examples/sdk
backend/.venv/bin/pyright --project backend/pyproject.toml
backend/.venv/bin/python backend/tools/check_architecture.py
backend/.venv/bin/python backend/tools/verify_imports.py
backend/.venv/bin/python backend/tools/export_contracts.py --check
```

行为改动使用独立 profile 对受影响的实际入口做有限验收；临时脚本、样本和报告在完成后清理，不保留常驻测试套件。模型评测由 `npm run eval` 显式运行，说明见 [evals](../packages/evals/README.md)。产品连接检查、会话诊断、资源普查与冻结包完整性校验继续保留。

用新隔离 profile 验收，不读取、迁移或删除用户历史库。禁止恢复 VM 链路、运行 prepare_runtime/bootstrap_resources，
以及反复打包积累磁盘。普通开发先做源码验证，需要安装验证时仅保留一份本轮包。
历史 VM 安装命令与报告保留在 Git 历史，不能用于当前本机验收。
当前候选、提交和证据见 [完成台账](../docs/python-backend-completion.md)；执行约束见 [实施入口](../docs/python-backend-native-next.md)。
