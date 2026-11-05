# AmazMe

操作用户本机环境的桌面 AI 助手，基于 Pi packages 的行为移植到 Python。Python 管理模型与账号、会话和 SQLite、审批、文件与 shell、PTY、stdio MCP、插件及工具账本；Web/Electron 与 Python SDK 共用同一 Host。

产品形态只有 Web/桌面客户端。终端只保留启动、诊断、配对、迁移和停服等后台管理命令；程序化调用使用 HTTP/WS 或 Python SDK。

当前阶段只通过仓库启动脚本使用，采用源码运行方式。启动时自动编译必要的客户端与 helper，不生成独立安装包或冻结 Python 后端，也不维护公证、发布和安装包更新流程。更新源码后先停止共享后台，再重新运行启动脚本。

会话支持分支、压缩、子任务、记忆、定时任务、工作流、搜索、项目、产物、分享及新格式导入导出。未知副作用保留原调用 ID，不自动重放；取消受理和进程退出分别核对。本机 shell 使用当前用户权限，路径校验和审批不构成操作系统沙箱。

## 从源码安装与使用

需要 Python 3.13、uv 和 Node.js 22.19 或更新版本。除特别说明外，下面的命令都默认在仓库根目录执行，仓库目录也就是默认工作区。

### 一键启动（macOS/Linux）

首次使用或依赖变更后，先准备 Python 与 Node 依赖：

```bash
./start.sh --prepare
```

日常启动默认打开桌面：

```bash
./start.sh            # 桌面
./start.sh web        # 浏览器页面
```

准备命令只同步依赖，不打开任何界面。普通启动不重复安装；桌面源码、资源、构建配置、构建脚本或已安装依赖变化时才重新构建所需的 workspace，然后使用仓库内的 Python 后端打开 Electron。`web` 之后的参数直接传给 Python，例如 `./start.sh web --workspace /absolute/project`。两种模式都会把 `AMAZME_PYTHON_BACKEND` 解析成绝对路径（默认仓库内的后端，已有覆盖时保留覆盖），不需要手动 `export`。

需要打开其他项目时，使用 `AMAZME_GUI_CWD=/absolute/project ./start.sh`，或用 `AMAZME_GUI_SESSION=会话ID` 指定已有会话。

首次打开后，在「设置 → 模型与连接」中：

1. 添加或配置供应商，完成 API Key 或 OAuth 登录。
2. 检测连接，勾选要启用的模型。
3. 在「新聊天默认模型」中选择默认值。输入区的模型选择器只修改当前会话，不改写新聊天的默认值。

Web 和 Desktop 默认共用 `~/.amazme/agent/python-host`。Host 按需启动并在客户端退出后继续运行。关闭桌面窗口时可隐藏窗口或退出桌面；菜单和托盘的「停止后台并退出」才会停止任务并断开所有客户端。更多窗口行为见 [桌面说明](packages/gui/README.md)。

### 统一数据目录与迁移

默认产品数据根是 `~/.amazme`。账号、会话、产品设置和执行账本在 `agent/python-host`，技能和模板在 `agent`，Electron 壳数据在 `desktop`。浏览器的面板布局、输入历史和待发送草稿仍属于各窗口。

`AMAZME_HOME` 改变产品根目录。`AMAZME_CODING_AGENT_DIR` 可覆盖 agent 目录，`AMAZME_PROFILE` 可单独选择业务 profile；显式 `--profile` 优先。`AMAZME_GUI_USER_DATA_DIR` 只选择桌面壳目录，不再隐式选择业务数据。

旧版桌面数据位于 `~/Library/Application Support/AmazMe/python-profile`。检测到该目录时，新启动器要求先迁移，避免打开另一份空库。在仓库根目录先预检：

```bash
backend/.venv/bin/amazme-backend migrate-profile --source-profile "$HOME/Library/Application Support/AmazMe/python-profile"
```

确认目标只有空白 profile 后，执行迁移并正常停止两端服务：

```bash
backend/.venv/bin/amazme-backend migrate-profile --source-profile "$HOME/Library/Application Support/AmazMe/python-profile" --apply --stop
```

迁移保留来源 profile 的身份、工作区、凭据、会话和执行账本，在旧桌面路径留下迁移标记。旧目录仅在事务期间暂存，校验成功后自动删除，不保留备份。目标已有业务数据、外部账号库链接或未结算副作用时拒绝迁移。中断后用相同参数重跑，工具根据事务记录恢复；已启用的新库不会被旧快照覆盖。事务中的旧目录禁止作为运行 profile。

两个入口都调用 Python 的 `connect`，并发启动只产生一个 Host。构建切换后的冻结校验和激活也由这个入口完成，只有正在运行的目标构建可以激活；校验失败时保持冻结。旧 Host 缺少共享连接能力时返回 `host_upgrade_required`；停止旧后端后再启动新版，不会另建一份数据。源码工具的 Node 由启动器显式传入。

### 浏览器页面

在仓库根目录执行：

```bash
./start.sh web
./start.sh web --workspace /absolute/project
```

启动脚本编译 Web 依赖后直接运行 Python 的 `web` 命令，在后台启动或复用 Host，并输出包含工作区身份的窗口链接。用浏览器打开该链接即可；关闭页面不停止后台任务。启动时不创建额外的空会话，页面按原有选择恢复会话。

### 后台管理与 Python SDK

普通桌面和 Web 使用不需要手动启动服务。后台管理命令使用项目虚拟环境：

```bash
backend/.venv/bin/amazme-backend doctor
backend/.venv/bin/amazme-backend stop
```

`doctor` 只检查已有 Host，不启动新后台；健康时退出码为 0，未就绪或不可用时为非零。`stop` 停止该 profile 的 Host 及所属服务，会影响所有连接它的客户端；重复停服安全。显式 `--profile /absolute/profile` 可选择其他业务目录。桌面也可使用菜单或托盘的「停止后台并退出」。

`connect --workspace /absolute/project` 返回供桌面使用的本机连接信息，其中包含私有连接令牌，不要把输出用于公开日志。`web` 只输出窗口链接，不包含令牌。新 profile 的 `init`、前台 `serve` 和迁移方式见 [Python 后端说明](backend/README.md)。

Python SDK 通过 Host URL 和连接令牌访问同一业务接口：

```bash
backend/.venv/bin/amazme-backend pair --profile /absolute/profile
```

配对码属于本机凭据，不要提交到仓库或放进分享链接。SDK 用法和示例见 [后端 SDK 文档](backend/docs/sdk.md)。不维护独立 Node CLI、JSON 行输出或 stdio RPC 客户端。

编译使用仓库中的模型快照，不联网刷新；需要同步上游模型数据时，显式指定 Pi 源码：

```bash
npm run sync:pi-models -- --source /absolute/pi/packages/ai/src/providers/data
```

## 客户端与工具

Electron 加载 Python 提供的页面；Web、桌面与 Python SDK 共用 Host、会话、账号和副作用账本。
SSH 使用系统 OpenSSH 和明确的主机密钥接纳，需要用户自己的账号，不以固定场景探针冒充产品实现。

Python factory 注册会话插件工具和命令，Codemode 通过现有 QuickJS helper 调用这些工具。
项目记忆、检查点、网页、定时任务等使用 Python 业务入口，不加载旧 TS Host、Chord facets 或 Durable 会话。
旧历史格式及旧生态不迁移；未知用户数据和凭据不删除。
OAuth 沿用 Pi 的客户端 ID、回调及请求身份；凭据由 Python 私有账号库管理，不写入会话导出或工具环境。

### 桌面操控（macOS）

桌面操控依赖用户在 macOS 14 及以上自行安装的 KimiCU；Linux 不提供桌面操控。旧版留下的 `~/Library/Application Support/AmazMe/ComputerUse` 和 `~/Library/Caches/AmazMe/ComputerUse` 可手动删除。

官方安装命令：

```bash
curl -fsSL https://cdn.kimi.com/kimi-computer-use/latest/setup_macos.sh | bash
```

应用安装到 `/Applications/KimiCU.app` 后，打开 KimiCU，按其界面授予辅助功能和屏幕录制权限。

在侧栏「插件 → MCP 服务 → 添加 MCP 服务」中保存全局 stdio MCP 配置：服务器名 `kimi-cu`，`enabled` 为 `true`，`exposure` 为 `direct`，`command` 为 `/Applications/KimiCU.app/Contents/MacOS/kimi-cu`，`args` 为 `["mcp", "-s", "user"]`。

## 开发与文档

| 范围 | 入口 |
| --- | --- |
| 唯一现行契约 | [Python 本机方案](docs/python-backend-plan.md) |
| 实施状态与证据 | [完成台账](docs/python-backend-completion.md) |
| SDK 与 Python 插件 | [后端 SDK 文档](backend/docs/sdk.md) |
| Electron 与本地构建 | [桌面说明](packages/gui/README.md) |
| QuickJS helper | [Codemode](packages/codemode/README.md) |
| 上游移植依据 | [UPSTREAM](UPSTREAM.md) |

开发采用 `confident-development-conventions`，代码逻辑正确性优先。改包后构建该包，按影响选择 Ruff、Pyright、TypeScript 类型与 `check:workspace` 检查，以及受影响的实际使用路径；必要验收通过后交付，同一份改动不重复验证。临时验证资产完成即清理，真实模型评测仍由 `npm run eval` 显式启动。不要主动运行根目录完整构建。
资源阈值由 `backend/tools/resource_census.py` 统一报告。当前阶段仅通过启动脚本运行源码；保留启动所需编译和类型检查，不生成安装包或冻结后端，不签名、公证、打标签或发布。

AmazMe 保留 Pi 的 MIT 许可证和版权归属，见 [LICENSE](LICENSE)。
