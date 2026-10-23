# AmazMe Python 后端 0.1.0

Python 后端提供独立 Web 客户端、DeepSeek Flash 流式模型、Linux VM 中的 shell/read_file/write_file。
P2 增加持久队列、审批、子工作、定时唤醒、完整状态重同步和更新冻结控制。
业务不加载旧 TS 内核，也不读取旧 profile。现有 TS 产品仍保留为后续客户端改造和功能建设的参考。

## 使用独立安装目录

构建结果是一个完整目录，必须整体保留。它包含 Python、Lima/VZ、guest agent、Linux 基础镜像、
Docker CLI 和离线容器镜像；运行时不需要系统 Python、Node、Colima 或 Docker CLI，也不临时安装依赖。
本阶段支持实测的 macOS arm64。历史闭环见 [P0/P1 运行记录](../docs/python-backend-p1-evidence.md)，
P2 当前产物、阶段证据与剩余验收见 [P2 交接](../docs/python-backend-p2-handoff.md)。P2 尚未完整验收。

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
会话 SQLite 与授权工作区文件保留。运行中不要改写安装目录。新构建按下面的私有更新协议切换；即使版本号相同，build_id 不同也需验证。

## 本阶段执行范围

- 一个 profile 对应一个显式授权的工作区、一个 VM；最多 8 个活动会话 worker，无需求时 120 秒回收。
- shell 是 Linux `/bin/sh`，镜像包含 Python 和基础系统命令；容器网络关闭，没有宿主 HOME、凭据、
  SSH agent 或运行时 socket。初始化工作区授予目录访问范围；默认 mutations 策略在 shell/write_file 执行前请求审批。
  `init --approval-policy all` 要求全部执行工具审批，`auto` 允许无逐步确认，适合明确授权的自动化验证。
- 每个工具 scope 一个容器，属于本次执行 epoch。受信任 PID 1 从运行时私有 stdin 收到许可后，
  才以工作区普通 UID 启动用户命令。scope 整体退出并核对 cgroup 后才能释放执行准入。
- 单工具最长 120 秒、内存 256 MiB、64 PID、stdout/stderr 各保留 64 KiB；超出输出继续排空并标记截断。
- 每会话最多 128 项待处理工作；必要子工作深度不超过 4、每层扇出不超过 8。模型上下文上限 256 KiB。
  快照保留全部未结算事项和近期结果，事件按完整事务批次保留，有界 ACK 与重同步不影响后台执行。
  请求 ID 去重记录随会话保存，不因事件过期而重做。
- shell 结果未知时不会自动重试。资源清理与效果核对分别显示；核对必须提供实际检查证据，
  不能通过“已处理”按钮绕过进程/容器清理。原未知回执保持不变。
- Xcode/AppleScript、完整 PTY、网络授权策略、受检编辑、多工作区、OAuth、插件和既有 Electron/TUI
  改造按后续阶段建设。这个最小工具镜像不等于全部开发工具链。

## 开发和构建

需要 CPython 3.13、uv；VM 资源构建机另需 Go 1.27.1 darwin/arm64、Lima 2.2.1 guest agent、Docker CLI 和固定 arm64 基础镜像。Go 只用于构建受管 Lima，不是后端或安装后的运行依赖。

```bash
uv sync --project backend --frozen
uv build --project backend
backend/.venv/bin/ruff check backend
backend/.venv/bin/pyright --project backend/pyproject.toml
backend/.venv/bin/pytest backend/tests -q
```

首次准备运行资源：

```bash
backend/.venv/bin/python backend/tools/prepare_runtime.py --go "/绝对路径/Go-1.27.1/bin/go"
backend/.venv/bin/python backend/tools/bootstrap_resources.py
backend/.venv/bin/python backend/tools/package_backend.py
```

`build_managed_lima.py` 校验固定 Lima 源码 commit 和 archive SHA，应用
`tools/patches/lima-2.2.1-mutation-lease.patch`，运行原生租约回归并构建、签名。补丁让启动命令与
VM 进程共同覆盖派生到登记的窗口，VM 运行后释放启动副本，避免变更锁泄漏到常驻进程。
`prepare_runtime.py` 拒绝没有该协议的管理器，并校验、复用已下载的 Colima 基础镜像（SHA-256
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
backend/.venv/bin/python backend/tools/verify_p2.py --executable "/绝对路径/源构建/amazme-backend" \
  --target-executable "/绝对路径/目标构建/amazme-backend" --case all
backend/.venv/bin/python backend/tools/verify_client.py --executable "/绝对路径/amazme-backend"
backend/.venv/bin/python backend/tools/verify_web.py \
  --provider-config "/本机私密目录/provider.json" --executable "/绝对路径/amazme-backend"
```

Web 验证使用独立 Chrome profile 和已安装的 Chrome，不复用个人浏览器会话。它实际配对、提交真实模型
任务、读取工作区效果、刷新重连、继续第二轮并截图。验证会消耗模型 API 用量。
`verify_client.py` 使用 faux，实际驱动浏览器测试丢回执、同 ID 重试、断网重连、迟到响应和草稿归属，
以及审批与冻结提示。`verify_p2.py --list` 列出每个故障用例，`--case` 可以选择子集；更新组必须提供两个
不同 build_id 的完整安装目录。默认使用 faux 和新 profile，不读取旧应用凭据。

运行器将 PATH 限为系统工具目录，记录逐用例断言和清理结果。故障矩阵使用自己创建的 `/tmp/am2-*`
HOME/profile/VM，浏览器报告位于 `.artifacts/python-backend-p2/`。退出后停止自建服务并删除 VM。
传入的模型配置仍由调用者保管；只有显式运行真实模型 Web 验证才会使用它，普通故障矩阵没有模型 API 消耗。
验收运行器被人为 SIGKILL 时，应按报告里的 profile 路径清理自建服务及 VM，不按进程名批量停止。

事件 JSON Schema 和 TS 声明通过 `backend/tools/export_contracts.py` 从 Python 生成。
公开 OpenAPI 从实际 Host 的 `/openapi.json` 导出至 `backend/contracts/openapi.json`；运行验收会比较
生成结果，防止接口变更后忘记同步。`export_contracts.py` 同时导出实际路由图的 OpenAPI。`tests/test_boundaries.py` 还限制业务模块直接启动宿主进程。

设计与进程职责见 [ARCHITECTURE.md](ARCHITECTURE.md)，已完成项和剩余验收见 [P2 交接](../docs/python-backend-p2-handoff.md)。

## 私有更新协议

更新请求只接受 `control.token`，普通 Web 配对凭据没有更新权限。执行脚本可读取 `ready.json` 得到当前 URL，
用 `Authorization: Bearer <control.token>` 调用：

1. `POST /control/updates/prepare`，提交稳定 `update_id`、目标 `target_build`、`cancel_work`。
   默认保留已接受的排队/审批/子工作等待；需要取消时明确设为 true。源构建进入冻结并取得清理证明。
2. 停止源 Host，以目标完整安装目录启动同一格式 2 profile。profile 保持冻结。
3. `POST /control/updates/{update_id}/resume`，验证完整参与者清单、构建指纹和验证 worker 的真实退出。
4. `POST /control/updates/complete`，提交相同 `update_id` 和最新 `expected_revision`。
   只有全部健康条件通过才激活；重复完成使用同一 ID。重启本身不会解除未完成更新。

`GET /api/v1/health` 提供监督器、所有 worker 实例、执行 epoch、清理状态和更新进度。
故障恢复使用私有 `POST /control/recover`，包含稳定 `recovery_id`、当前 `host_epoch`、`build_id`，
可指定 `session_id`。恢复仍需证明旧资源和进程停止，不能强制忽略屏障。

P2 使用格式 2，首次运行须重新 init；不读取或迁移 P1 格式 1 及旧 TS 数据。
故障注入仅在显式 `init --test-mode` 的隔离 profile 启用，通过私有文件 rendezvous 暂停，
没有网络注入接口。测试必须核对自建进程身份后再发送信号。
