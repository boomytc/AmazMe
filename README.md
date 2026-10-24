# AmazMe

操作用户本机环境的桌面 AI 助手，基于 Pi packages 的行为移植到 Python。Python 管理模型与账号、会话和 SQLite、审批、文件与 shell、PTY、stdio MCP、插件及工具账本；Web/Electron、TUI、CLI、RPC 和 Python SDK 共用同一 Host。

会话支持分支、压缩、子任务、记忆、定时任务、工作流、搜索、项目、产物、分享及新格式导入导出。未知副作用保留原调用 ID，不自动重放；取消受理和进程退出分别核对。本机 shell 使用当前用户权限，路径校验和审批不构成操作系统沙箱。

## 从源码启动

需要 Python 3.13、uv 和 Node.js 22.19 或更新版本。在仓库根目录准备依赖：

```bash
uv sync --project backend --frozen
npm install --ignore-scripts
npm run build:offline
export AMAZME_PYTHON_BACKEND=/absolute/AmazMe/backend/.venv/bin/amazme-backend
```

构建使用仓库中的 Python 模型快照，不联网刷新。需要同步上游时显式指定 Pi 源码数据：

```bash
npm run sync:pi-models -- --source /absolute/pi/packages/ai/src/providers/data
```

在实际项目目录启动终端客户端：

```bash
cd /absolute/project
node /absolute/AmazMe/packages/coding-agent/dist/bundle/cli.js
```

首次使用先配置供应商及账号，再选择模型。详细命令见 [CLI](packages/coding-agent/README.md) 和 [Python 后端](backend/README.md)。OAuth 沿用 Pi 的客户端 ID、回调及请求身份；凭据由 Python 私有账号库管理，不写入会话导出或工具环境。

```bash
amazme models
amazme auth login --provider openai-codex
amazme doctor
amazme --continue
amazme --print '说明当前项目的启动入口'
amazme --mode rpc
```

上例的 `amazme` 可用完整 Node 入口替代，或构建后运行 `npm link --workspace @amazme/coding-agent --ignore-scripts`。
本机 CLI 按启动目录选择工作区；`--workspace NAME` 选择已登记目录。`--session ID` 指定会话，`--no-session` 使用按退出证明清理的临时历史。
技能、上下文文件、提示模板、图片输入及推理等级沿用 Pi 的使用方式。

## 客户端与工具

Electron 加载 Python 提供的页面；Web、TUI、CLI 与 SDK 都连接原服务。
关闭页面或释放 attachment 不取消已接纳的工作，显式退出收回客户端拥有的进程。
真实 macOS 桌面驱动使用已有 CUA App 和系统 TCC 状态；SSH 使用系统 OpenSSH 和明确的主机密钥接纳。
这两项需要用户自己的系统授权或账号，不以固定场景探针冒充产品实现。

Python factory 注册会话插件工具和命令，Codemode 通过现有 QuickJS helper 调用这些工具。
项目记忆、检查点、网页、定时任务等使用 Python 业务入口，不加载旧 TS Host、Chord facets 或 Durable 会话。
旧历史格式及旧生态不迁移；未知用户数据和凭据不删除。

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
