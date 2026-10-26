# AmazMe

操作用户本机环境的桌面 AI 助手，基于 Pi packages 的行为移植到 Python。Python 管理模型与账号、会话和 SQLite、审批、文件与 shell、PTY、stdio MCP、插件及工具账本；Web/Electron、TUI、CLI、RPC 和 Python SDK 共用同一 Host。

会话支持分支、压缩、子任务、记忆、定时任务、工作流、搜索、项目、产物、分享及新格式导入导出。未知副作用保留原调用 ID，不自动重放；取消受理和进程退出分别核对。本机 shell 使用当前用户权限，路径校验和审批不构成操作系统沙箱。

## 从源码安装与使用

需要 Python 3.13、uv 和 Node.js 22.19 或更新版本。除特别说明外，下面的命令都默认在仓库根目录执行，仓库目录也就是默认工作区。

### 一键启动桌面（macOS/Linux）

```bash
./start.sh
```

脚本会自动回到仓库根目录，检查 uv 和 npm，同步 Python 与 Node 依赖，构建桌面所需的 workspace，并使用仓库内的 Python 后端打开 Electron。可以重复执行，不需要先手动运行 `serve` 或设置后端路径。

依赖已经准备好时，可跳过依赖安装，直接运行 `npm run dev:desktop`；它同样会自动使用仓库后端。需要打开其他项目时，使用 `AMAZME_GUI_CWD=/absolute/project ./start.sh`，或用 `AMAZME_GUI_SESSION=会话ID` 指定已有会话。

首次打开后，在「设置 → 模型与连接」中：

1. 添加或配置供应商，完成 API Key 或 OAuth 登录。
2. 检测连接，勾选要启用的模型。
3. 在「新聊天默认模型」中选择默认值。输入区的模型选择器只修改当前会话，不改写新聊天的默认值。

关闭主窗口默认只隐藏，已接纳的会话和后台工作继续运行；通过托盘恢复窗口。需要结束时，使用托盘菜单或 `Cmd/Ctrl+Q` 显式退出，桌面壳才会停止自己拥有的后端。更多窗口行为见 [桌面说明](packages/gui/README.md)。

### 手动准备与其他客户端

一键桌面不需要先执行全量构建。需要终端、RPC 或手动分步操作时，在仓库根目录执行：

```bash
uv sync --project backend --frozen
npm install --ignore-scripts
npm run build:offline
export AMAZME_PYTHON_BACKEND=backend/.venv/bin/amazme-backend
```

`AMAZME_PYTHON_BACKEND` 用于终端和 Web 找到后端，桌面启动脚本会自动处理。继续在仓库根目录操作时可直接使用这个相对路径；离开仓库目录运行终端命令时，应改成对应入口的绝对路径。新开终端也需要重新设置该变量。

构建使用仓库中的 Python 模型快照，不联网刷新；只有需要同步上游模型数据时，才显式指定 Pi 源码：

```bash
npm run sync:pi-models -- --source /absolute/pi/packages/ai/src/providers/data
```

### 交互终端与一次性命令

直接使用构建后的 Node 入口：

```bash
node packages/coding-agent/dist/bundle/cli.js
```

不带参数会进入交互终端（TUI）。一次性提问或用于脚本时：

```bash
node packages/coding-agent/dist/bundle/cli.js --print '说明当前项目的启动入口'
```

终端入口按启动目录选择工作区，会复用仍存活的本机 Host，没有时才启动新的 Host。`--workspace NAME` 选择已登记工作区，`--continue` 继续最近的非归档会话，`--session ID` 打开指定会话；`workspaces list` 可查看登记目录。

如果希望使用短命令，可在仓库根目录执行一次：

```bash
npm link --workspace @amazme/coding-agent --ignore-scripts
```

之后可将完整 Node 入口替换为 `amazme`。首次配置和常用操作示例：

```bash
amazme models
amazme auth login --provider openai-codex
amazme auth login --provider openai --method api-key
amazme doctor
amazme --continue
```

`auth login` 用于完成账号登录，`models` 查看模型目录，`doctor` 检查 Host 健康状态。API Key 也可通过隐藏的交互提示输入，不必写进命令。更多会话、技能、图片和推理参数见 [CLI 说明](packages/coding-agent/README.md)。

普通持久会话在离开 TUI 或一次性命令结束后，不会因释放客户端绑定而取消已接纳的工作。`--no-session` 是临时会话，退出时按清理证明关闭其拥有的后端并清除已结算历史。

### 浏览器页面

在仓库根目录执行：

```bash
npm run dev:web
```

该命令构建 Web 依赖、启动或复用本机 Host，并输出窗口链接；在浏览器中打开终端给出的地址即可，默认以仓库目录作为工作区。需要其他项目时，可从该项目目录运行 CLI 的 `web`，此时 Node 和后端入口应使用绝对路径。

只需要 Host 根地址而不需要窗口链接时，使用 `server` 替代 `web`。关闭网页或释放客户端绑定不会取消已经接纳的工作。

### 已有 Host、独立服务、RPC 与 SDK

普通桌面、TUI 和 Web 使用不需要提前手动启动服务。只有需要连接已有 Host、独立管理服务，或使用 RPC/Python SDK 时，才需要以下方式。

已有初始化的 profile 时，在仓库根目录启动服务：

```bash
backend/.venv/bin/python -m amazme_backend serve --profile /absolute/profile
```

保持该终端运行，直接用浏览器打开服务输出的本机 URL，无需配对。
TUI、SDK 等客户端连接指定 Host 时，在另一个终端取得连接令牌：

```bash
backend/.venv/bin/python -m amazme_backend pair --profile /absolute/profile
```

然后用 Host 地址和令牌连接。以打印 Web 页面地址为例：

```bash
node packages/coding-agent/dist/bundle/cli.js web --python-url http://127.0.0.1:PORT --python-token '配对码'
```

`--python-url` 和 `--python-token` 必须同时提供，同样适用于 TUI、一次性命令及 `models`、`auth`、`doctor` 等命令。配对码属于本机凭据，不要提交到仓库或放进分享链接。新 profile 的初始化方式见 [Python 后端说明](backend/README.md)。

RPC 客户端使用 `--mode rpc`；Python SDK 使用 Host URL 和配对码连接，示例见 [SDK 与 RPC 文档](packages/coding-agent/docs/sdk.md)。

独立服务需要停止时，在另一个终端执行：

```bash
backend/.venv/bin/python -m amazme_backend stop --profile /absolute/profile
```

`stop` 会停止该 profile 的 Host 及所属服务，所有连接它的客户端都会受影响。桌面端应优先使用窗口或托盘提供的显式退出操作。

## 客户端与工具

Electron 加载 Python 提供的页面；Web、TUI、CLI、RPC 与 SDK 共用 Host、会话、账号和副作用账本。
真实 macOS 桌面驱动使用已有 CUA App 和系统 TCC 状态；SSH 使用系统 OpenSSH 和明确的主机密钥接纳。
这两项需要用户自己的系统授权或账号，不以固定场景探针冒充产品实现。

Python factory 注册会话插件工具和命令，Codemode 通过现有 QuickJS helper 调用这些工具。
项目记忆、检查点、网页、定时任务等使用 Python 业务入口，不加载旧 TS Host、Chord facets 或 Durable 会话。
旧历史格式及旧生态不迁移；未知用户数据和凭据不删除。
OAuth 沿用 Pi 的客户端 ID、回调及请求身份；凭据由 Python 私有账号库管理，不写入会话导出或工具环境。

## 开发与文档

| 范围 | 入口 |
| --- | --- |
| 唯一现行契约 | [Python 本机方案](docs/python-backend-plan.md) |
| 实施状态与证据 | [完成台账](docs/python-backend-completion.md) |
| SDK、RPC 与插件 | [客户端文档](packages/coding-agent/docs/sdk.md) |
| Electron 与本地构建 | [桌面说明](packages/gui/README.md) |
| QuickJS helper | [Codemode](packages/codemode/README.md) |
| 上游移植依据 | [UPSTREAM](UPSTREAM.md) |

改包后构建该包并运行相关检查。不要主动运行根目录完整测试或完整构建；最终集中检查包括 Python Ruff、Pyright、后端测试、受影响客户端及 `check:workspace`，修改工程脚本时还包括 `test:engineering`。
资源阈值由 `backend/tools/resource_census.py` 统一报告。1.0.0 前只做本地自用构建，不公证、不发布、不打标签。

AmazMe 保留 Pi 的 MIT 许可证和版权归属，见 [LICENSE](LICENSE)。
