# AmazMe Python 后端 0.1.0

AmazMe 正在按 [本机优先方案](../docs/python-backend-plan.md) 将 shell、文件、PTY、MCP 改为操作用户真实环境。
保留 Python 会话、模型、SQLite、审批及客户端，移除 VM 默认执行依赖。状态见 [验收台账](../docs/python-backend-completion.md)。

本机 shell 具有当前用户权限，文件 API 的路径检查和命令审批不构成操作系统沙箱。
不自动把后端令牌、模型密钥传给工具；继续保留签名、公证和系统权限要求。

本机 shell、文件、审批、检查点和 PTY 已接通 Web。MCP 正在下一阶段接入，当前接口返回
`native_interactive_pending`。普通 shell 不用于声明长驻服务；开发服务器可在会话终端运行，
关闭页面不会停止终端，使用「关闭终端」或停止后端结束它。监督器失联后不自动重启命令。

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
```

`verify_native.py` 使用 faux 和真实本机进程；`verify_client.py` 使用已安装 Chrome。
真实模型与 Chrome 用 `verify_web.py --provider-config /private/provider.json`，会产生模型费用。
这些运行器创建自己的隔离 profile、记录报告并关闭所属进程；不会接管用户原有服务。
报告保存在 `.artifacts/native`，两个 native `run-*` 之后先核对已有证据再运行，避免无界积累。

用新隔离 profile 验收，不读取、迁移或删除用户历史库。禁止恢复 VM 链路、运行 prepare_runtime/bootstrap_resources，
以及反复打包积累磁盘。普通开发先做源码验证，需要安装验证时仅保留一份本轮包。
历史 VM 安装命令与报告保留在 Git 历史和 docs/python-backend-p2-handoff.md，不能用于当前本机验收。
