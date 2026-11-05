# AmazMe Python 后端

AmazMe 按 [本机优先方案](../docs/python-backend-plan.md) 使用 Python shell、文件、PTY、MCP 操作用户真实环境。
保留 Python 会话、模型、SQLite、审批及客户端，移除 VM 默认执行依赖。状态见 [验收台账](../docs/python-backend-completion.md)。

Python SDK 入口是 `amazme_backend.sdk.Client`，说明见 [SDK](docs/sdk.md)，可运行示例在 [examples/sdk](examples/sdk/README.md)。

本机 shell 具有当前用户权限，文件 API 的路径检查和命令审批不构成操作系统沙箱。
不自动把后端令牌、模型密钥传给工具；保留本机系统权限要求。

模型可用 `glob(pattern, path=".")` 发现工作区文件，`**` 跨目录、无 `/` 的模式匹配任意深度的文件名，支持 `{a,b}`。字面目录前缀会缩小遍历范围；最多返回已遍历匹配中最新的 100 个路径，包含隐藏和忽略文件并排除 VCS 元数据。`grep(pattern, path=".", include="", ignore_case=False)` 使用 Python 正则返回路径、行号和预览，遵循嵌套 `.gitignore` 并排除隐藏、二进制和符号链接。空 `include` 不限制类型；非空值是一个正向 glob。两者都沿会话执行账本按只读调用运行，不要求 shell 修改审批，也不依赖额外搜索二进制。

搜索最多扫描 100000 个目录条目、64 层目录；内容搜索总共读取至多 64 MiB，单文件最多 16 MiB、单行最多 65536 字节。结果最多 250 条、JSON 匹配项约 48 KB，行预览至多 2000 字节。查看 `truncated`、`skipped_files` 和 `reason` 判断完整性，受限时缩小范围。搜索结果不构成文件读取版本，写入前仍用 `read_file`。取消和 30 秒超时也能中断单次正则匹配。

模型可用 `apply_patch` 提交 Codex 格式的多文件补丁，支持新增、更新、移动和删除，自动创建新增文件的父目录。已有源文件和覆盖目标必须先通过 `read_file` 取得版本。Host 对整批内容做预检并保存原文件检查点，Supervisor 在执行前再次核对版本，沿用当前会话的修改审批。每次最多 16 个文件操作，输入最多 32000 个字符，准备后的计划最多 128000 字节；超限时拆分补丁。执行按顺序进行，失败后停止，不回滚此前已完成的文件，结果列出完成、失败和跳过项。未知结果需要核对文件，不能重发补丁。更新内容采用 LF 换行。

`ask_user_question` 可提出 1–3 个问题，每题支持至多 8 个选项、单选、多选和自由输入。问题进入会话的 `waiting_input` 状态，不申请执行许可；用户的回答也不批准其他工具。Web 的推荐项只预选，必须显式提交；跳过会形成明确结果并提示模型不要重复提问。取消后拒绝晚到回答。无执行资源的待答请求树在普通停机时保留，重开后更新问题代次，用户重新连接后可继续回答；显式取消仍结束请求。

Web 与 Python SDK 使用同一结构化提问契约，回答和跳过都携带稳定 `decision_id`、问题身份及提案摘要；同编号同内容查询原决定，不得用原编号改答案。

本机 shell、文件、审批、检查点、PTY 和 stdio MCP 服务已接通 Web。用户可以连接服务、选择工具、填写 JSON 参数并审批调用。已连接服务的工具目录也会交给模型；模型提出的调用走会话审批，不能调用 Host 的用户审批接口代替决定，批准后的结果进入后续模型上下文。

动态目录刷新及媒体回传已有定向检查；HTTP/OAuth 等其他 MCP 传输不属于当前 stdio 主路径。
普通 shell 不用于声明长驻服务；开发服务器可在会话终端运行，
关闭页面不会停止终端，使用「关闭终端」或停止后端结束它。监督器失联后不自动重启命令。
终端协议窗口保持 32 KiB，监督器按已读输出归还信用。重连记录最多 256 KiB，页面解释光标、换行和清屏；直接按键与表单共用输入账本，接收输入不等于命令成功。Electron 装载这份页面；窗口关闭按桌面偏好处理，普通退出只关闭桌面，显式「停止后台并退出」才停止共享后端。网页和 Python SDK 在同一会话上等待显式批准，并能操作终端、文件、检查点和本机 MCP；离开、松开绑定或进程退出不关闭这些服务。
审批绑定明确提案和稳定决定 ID；未知回执查询原请求，不因客户端断开重新执行。
模型选择请求不携带密钥。更换或清除密钥走单独入口；过期代际不会覆盖新密钥，响应里也不出现密钥。
内置供应商 Command Code 共用一个 API key，默认使用「自动（按模型）」协议：依据公开目录的 `supported_endpoints`，Claude 走 Anthropic Messages、GPT 优先走 OpenAI Responses，其余兼容模型走 Chat Completions。配置、切换默认模型及重启均保留自动模式；如需固定协议，可在供应商配置中修改。目录随程序提供，启动不联网刷新；维护时运行 `npm run sync:command-code-models`，来源与接口说明见 [Command Code Provider](https://commandcode.ai/docs/provider)。目录未提供的价格保持未知。
MCP 服务同样归属会话；停止服务后，未取得结果的调用保持 `unknown`，不能自动重试。

本地 Web 和 Desktop 共用 `connect --workspace /absolute/project`。它在规范 profile 的启动锁内完成初始化、探活和 detached 启动，再校验 Host 能力、身份与工作区。普通客户端退出不会关闭 Host。默认目录和旧数据迁移见[根说明](../README.md#统一数据目录与迁移)。

`web --workspace /absolute/project` 直接输出本机窗口链接；`doctor [--profile /absolute/profile]` 查询已有 Host 的健康状态，既不初始化 profile，也不启动服务。`connect` 的私有 JSON 输出仅供桌面连接使用。`stop`、`pair`、`init`、`serve` 和 `migrate-profile` 保留为后台管理入口。业务操作使用 HTTP/WS 和 Python SDK，不维护终端会话客户端。

首次启动使用新的 profile、实际项目目录和权限为 0600 的供应商 JSON（`provider`、`model`、
`api_key`）；不要把该 JSON 放入仓库。`init` 复制配置后，原临时文件可删除。

```bash
backend/.venv/bin/python -m amazme_backend init --profile /absolute/new-profile --workspace /absolute/project --provider-config /private/provider.json
backend/.venv/bin/python -m amazme_backend serve --profile /absolute/new-profile
```

`serve` 输出回环 URL，浏览器直接打开即可，无需配对。页面自动设置本机连接 Cookie。
Python SDK 的连接令牌用 `pair --profile /absolute/new-profile` 取得；
退出用 `stop --profile /absolute/new-profile`，均通过同一模块命令运行。
默认修改操作需要审批。执行环境保留 PATH/HOME 等工具查找变量，不继承模型密钥和控制令牌。

工具搜索通过 PyICU 使用 ICU 的多语言词典分词。源码安装前需准备 ICU 开发库与 `pkg-config`：macOS 用 `brew install pkg-config icu4c`，并将 `$(brew --prefix icu4c)/lib/pkgconfig` 加入 `PKG_CONFIG_PATH`；Debian/Ubuntu 用 `apt install pkg-config libicu-dev`。详见 [PyICU 安装说明](https://pypi.org/project/pyicu/)。通过项目虚拟环境运行，使用本机安装的 ICU 开发库。

开发采用 `confident-development-conventions`，从状态归属、类型与模块边界保证逻辑闭环。按本次改动选择必要检查：

```bash
uv sync --project backend --frozen
backend/.venv/bin/ruff check backend/src backend/examples/sdk
backend/.venv/bin/pyright --project backend/pyproject.toml
backend/.venv/bin/python backend/tools/check_architecture.py
backend/.venv/bin/python backend/tools/verify_imports.py
backend/.venv/bin/python backend/tools/export_contracts.py --check
```

行为改动使用独立 profile 对受影响的实际入口做有限验收；临时脚本、样本和报告在完成后清理，不保留常驻测试套件。模型评测由 `npm run eval` 显式运行，说明见 [evals](../packages/evals/README.md)。产品连接检查、会话诊断、资源普查继续保留。

用新隔离 profile 验收，不读取、迁移或删除用户历史库。禁止恢复 VM 链路、运行 prepare_runtime/bootstrap_resources，
以及任何安装包或冻结后端构建。当前阶段仅通过启动脚本运行源码。
历史 VM 安装命令与报告保留在 Git 历史，不能用于当前本机验收。
当前候选、提交和证据见 [完成台账](../docs/python-backend-completion.md)；执行约束见 [实施入口](../docs/python-backend-native-next.md)。
