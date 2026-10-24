# AmazMe Python 后端 0.1.0

AmazMe 正在按 [本机优先方案](../docs/python-backend-plan.md) 将 shell、文件、PTY、MCP 改为操作用户真实环境。
保留 Python 会话、模型、SQLite、审批及客户端，移除 VM 默认执行依赖。状态见 [验收台账](../docs/python-backend-completion.md)。

本机 shell 具有当前用户权限，文件 API 的路径检查和命令审批不构成操作系统沙箱。
不自动把后端令牌、模型密钥传给工具；继续保留签名、公证和系统权限要求。

本机 shell、文件、审批、检查点、PTY 和 stdio MCP 服务已接通 Web。用户可以连接服务、
选择工具、填写 JSON 参数并审批调用。已连接服务的工具目录也会交给模型；模型提出的调用走会话审批，
不能调用 Host 的用户审批接口代替决定，批准后的结果进入后续模型上下文。
动态目录刷新、HTTP/OAuth、媒体呈现和任意第三方服务兼容性尚未验收。
普通 shell 不用于声明长驻服务；开发服务器可在会话终端运行，
关闭页面不会停止终端，使用「关闭终端」或停止后端结束它。监督器失联后不自动重启命令。
终端协议窗口保持 32 KiB，监督器按已读输出归还信用。重连记录最多 256 KiB，页面解释光标、换行和清屏；直接按键与表单共用输入账本，接收输入不等于命令成功。Electron 可以装载这份页面；关闭窗口不停止后端，显式退出才停止它所启动的后端。`amazme-backend tui`、print/JSON CLI、`--mode rpc`、Python SDK 和默认 `amazme` 交互画面在同一会话上等待显式批准，并能操作终端、文件、检查点和本机 MCP；离开、松开绑定或进程退出不关闭这些服务。
MCP 服务同样归属会话；停止服务后，未取得结果的调用保持 `unknown`，不能自动重试。

首次启动使用新的 profile、实际项目目录和权限为 0600 的供应商 JSON（`provider`、`model`、
`api_key`）；不要把该 JSON 放入仓库。`init` 复制配置后，原临时文件可删除。

```bash
backend/.venv/bin/python -m amazme_backend init --profile /absolute/new-profile --workspace /absolute/project --provider-config /private/provider.json
backend/.venv/bin/python -m amazme_backend serve --profile /absolute/new-profile
```

`serve` 输出回环 URL。另一个终端运行 `pair --profile /absolute/new-profile` 取得配对码，
在浏览器中配对。退出用 `stop --profile /absolute/new-profile`，均通过同一模块命令运行。
默认修改操作需要审批。执行环境保留 PATH/HOME 等工具查找变量，不继承模型密钥和控制令牌。

开发验证：

```bash
uv sync --project backend --frozen
uv build --project backend
backend/.venv/bin/ruff check backend
backend/.venv/bin/pyright --project backend/pyproject.toml
backend/.venv/bin/pytest backend/tests -q
backend/.venv/bin/python backend/tools/verify_native.py
backend/.venv/bin/python backend/tools/verify_client.py
backend/.venv/bin/python backend/tools/verify_terminal.py
backend/.venv/bin/python backend/tools/verify_mcp.py
backend/.venv/bin/python backend/tools/verify_screen.py
```

`verify_native.py` 使用 faux 和真实本机进程；`verify_client.py` 使用已安装 Chrome。
`verify_mcp.py` 用 Chrome 操作本机官方 MCP Python SDK 探针服务，覆盖审批、丢回执、结构化结果和停止。
`verify_mcp_model.py` 用隔离 profile 和现有 DeepSeek 配置，让模型选择已连接的本机探针工具；拒绝无副作用，批准后的结果回到模型。
两者都不代表动态目录、其他传输或任意第三方服务已通过。
真实模型与 Chrome 用 `verify_web.py --provider-config /private/provider.json`，会产生模型费用。
这些运行器创建自己的隔离 profile、记录报告并关闭所属进程；不会接管用户原有服务。
报告保存在 `.artifacts/native`，两个 native `run-*` 之后先核对已有证据再运行，避免无界积累。

用新隔离 profile 验收，不读取、迁移或删除用户历史库。禁止恢复 VM 链路、运行 prepare_runtime/bootstrap_resources，
以及反复打包积累磁盘。普通开发先做源码验证，需要安装验证时仅保留一份本轮包。
历史 VM 安装命令与报告保留在 Git 历史和 docs/python-backend-p2-handoff.md，不能用于当前本机验收。
当前阶段的提交、证据、剩余顺序和执行约束见 [阶段交接](../docs/python-backend-native-next.md)。
