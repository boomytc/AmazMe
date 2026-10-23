# AmazMe Python 后端 0.1.0

P0/P1 提供一个独立 Web 客户端、DeepSeek Flash 流式模型、Linux VM 中的 shell/read_file/write_file，
以及请求去重、取消、worker 强杀恢复、Host 接管和本机独立 onedir。
业务不加载旧 TS 内核，也不读取旧 profile。现有 TS 产品仍保留为后续客户端改造和功能建设的参考。

## 使用独立安装目录

构建结果是一个完整目录，必须整体保留。它包含 Python、Lima/VZ、guest agent、Linux 基础镜像、
Docker CLI 和离线容器镜像；运行时不需要系统 Python、Node、Colima 或 Docker CLI，也不临时安装依赖。
本阶段支持实测的 macOS arm64。实际产物路径和证据见 [P0/P1 运行记录](../docs/python-backend-p1-evidence.md)。

先在仓库外创建权限为 `0600` 的模型配置 JSON：

```json
{
  "provider": "deepseek",
  "base_url": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "api_key": "填写自己的 API key",
  "max_tokens": 2048
}
```

初始化明确授权的工作区。profile 必须是尚不存在的目录：

```bash
AMAZME_BIN="/绝对路径/AmazMe Python 0.1.0/amazme-backend"
"$AMAZME_BIN" init --profile "$HOME/.local/share/amazme-python/default" \
  --workspace "/绝对路径/项目" --provider-config "/本机私密目录/provider.json"
"$AMAZME_BIN" serve --profile "$HOME/.local/share/amazme-python/default"
```

启动输出给出本次回环 URL。在另一个终端取得配对码，输入 Web 页面的配对框：

```bash
"$AMAZME_BIN" pair --profile "$HOME/.local/share/amazme-python/default"
```

配对码不放 URL 或 localStorage，浏览器通过 HttpOnly/SameSite cookie 连接。创建会话、输入任务、
观察流式回复与工具结果；刷新页面会恢复持久状态。普通页面关闭不会取消已接受任务。
取消先返回“正在清理”，确认执行域已停止后才显示已取消。未知效果不自动重做。

显式停止全部本 profile 服务并关闭 VM：

```bash
"$AMAZME_BIN" stop --profile "$HOME/.local/share/amazme-python/default"
```

`serve` 可再次启动同一新后端 profile。`destroy-vm` 仅用于已经停止的 profile 的 VM 数据清理；
会话 SQLite 与授权工作区文件保留。运行中不要改写安装目录；新构建需先停止旧构建。

## 本阶段执行范围

- 一个 profile 对应一个显式授权的工作区、一个 VM；最多 8 个活动会话 worker，无需求时 120 秒回收。
- shell 是 Linux `/bin/sh`，镜像包含 Python 和基础系统命令；容器网络关闭，没有宿主 HOME、凭据、
  SSH agent 或运行时 socket。初始化工作区就是对其中读写与命令执行的授权，本阶段不提供逐工具审批 UI。
- 每个工具 scope 一个容器，属于本次执行 epoch。受信任 PID 1 从运行时私有 stdin 收到许可后，
  才以工作区普通 UID 启动用户命令。scope 整体退出并核对 cgroup 后才能释放执行准入。
- 单工具最长 120 秒、内存 256 MiB、64 PID、stdout/stderr 各保留 64 KiB；超出输出继续排空并标记截断。
- 每会话最多 128 个请求、排队 32 个、模型上下文序列化上限 256 KiB、每次任务最多 8 轮模型调用。
  Web 快照显示最近 20 个请求，并保留当前执行项；工具面板恢复最近 16 条工具事件。
  旧请求的 ID 查询与去重记录仍在。上限明确拒绝，不静默丢数据。
- Xcode/AppleScript、完整 PTY、网络授权策略、受检编辑、多工作区、OAuth、插件和既有 Electron/TUI
  改造按后续阶段建设。这个最小工具镜像不等于全部开发工具链。

## 开发和构建

需要 CPython 3.13、uv；VM 资源构建机另需 Lima 2.2.1、Docker CLI、实测固定 arm64 基础镜像。

```bash
uv sync --project backend --frozen
uv build --project backend
backend/.venv/bin/ruff check backend
backend/.venv/bin/pyright --project backend/pyproject.toml
backend/.venv/bin/pytest backend/tests -q
```

首次准备运行资源：

```bash
backend/.venv/bin/python backend/tools/prepare_runtime.py
backend/.venv/bin/python backend/tools/bootstrap_resources.py
backend/.venv/bin/python backend/tools/package_backend.py
```

`prepare_runtime.py` 校验并复用已下载的 Colima 基础镜像（SHA-256
`1fc0354f4f99734ce3886628cc7af8b0437c1a1d391b126bd09cba0df35ee53f`）；缺少时明确失败，
不会下载替代版本。`bootstrap_resources.py` 只在构建时联网取得固定容器镜像并导出离线 archive，
用完删除自建 VM。二进制、镜像及摘要放在忽略的 `backend/resources/`。
`package_backend.py` 冻结后移动到带空格的目录，打包全部资源并生成包含实际文件摘要的不可变 build_id。
wheel 用于源码工程检查，实际独立交付物是 onedir。当前是本机 ad-hoc 产物，尚不是 Developer ID
签名、公证后的对外分发 DMG；未执行标签或 Release。

开发态用 `uv run --project backend amazme-backend` 替代上面的二进制。`init` 只显式读取给定的模型
配置，不自动查找旧应用凭据。秘密不进入源码、协议 schema、普通日志或验收报告。

## 可重跑验收

```bash
backend/.venv/bin/python backend/tools/verify_runtime.py
backend/.venv/bin/python backend/tools/verify_runtime.py --executable "/绝对路径/amazme-backend"
backend/.venv/bin/python backend/tools/verify_client.py --executable "/绝对路径/amazme-backend"
backend/.venv/bin/python backend/tools/verify_web.py \
  --provider-config "/本机私密目录/provider.json" --executable "/绝对路径/amazme-backend"
```

Web 验证使用独立 Chrome profile 和已安装的 Chrome，不复用个人浏览器会话。它实际配对、提交真实模型
任务、读取工作区效果、刷新重连、继续第二轮并截图。验证会消耗模型 API 用量。
`verify_client.py` 使用 faux 模型，实测丢回执后刷新并重发、断网重连、迟到响应与草稿归属、
输入拒绝后修正及清理失败的实时显示。`verify_runtime.py` 另覆盖重复取消、并发恢复、
最大文件写入、运行中删除 VM 被拒绝、启动失败后资源释放。
运行器将 PATH 限为系统工具目录，在每轮新的 `.artifacts/python-backend-p1/` 子目录内保存报告；
结束后停止服务、删除自建 VM，并清空测试 profile 的模型密钥；传入的 provider 配置仍由调用者保管。
若人为 SIGKILL 验收运行器，需按该轮 profile 路径执行 stop/destroy-vm 并清理其密钥副本。

事件 JSON Schema 和 TS 声明通过 `backend/tools/export_contracts.py` 从 Python 生成。
公开 OpenAPI 从实际 Host 的 `/openapi.json` 导出至 `backend/contracts/openapi.json`；运行验收会比较
生成结果，防止接口变更后忘记同步。`tests/test_boundaries.py` 还限制业务模块直接启动宿主进程。

设计与进程职责见 [ARCHITECTURE.md](ARCHITECTURE.md)，已完成项和剩余验收见运行记录。
