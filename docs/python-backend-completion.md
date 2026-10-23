# Python 后端重构验收台账

日期：2026-10-23。分支 `dev`。本文件按用户能完成的操作记录状态，并随实现更新。四类状态分开，不能互相冒充：

1. **P2 代码和协议**：持久化、生命周期、故障注入和 faux 客户端。已跑过的才算通过。
2. **P2 环境**：真实文件系统空间耗尽、宿主睡眠/唤醒、物理断电。模拟不能算通过。
3. **P3 产品与客户端**：方案第 2、6、7 节里尚未由 Python 内核闭环的能力。
4. **P4 交付**：完整安装资源、签名公证、平台实测、性能和旧 TS 业务依赖清理。

P2 的代码和协议门槛通过后，可以继续没有被环境挡住的 P3。环境项和公证未完成时，整个重构仍未完成。改定义不能把未跑项标成通过。

## 当前证据

| 项 | 值 |
| --- | --- |
| 矩阵与浏览器所依据的源码 | `d5cefaf0faa02505fe8e8696a5b7fd01df723f49` |
| 会话分支所依据的源码 | `0b73c8262a17982893326e07ca9a4ad15bb2e7de` |
| 安装 A | `.artifacts/python-backend-p2/package-gbn32ffr/AmazMe Python 0.1.0` |
| A build_id | `257b71973f69ed8fe2178ab41acddbb973360e44db507dc7c7ba7a1af6ddac5c` |
| 安装 B | `.artifacts/python-backend-p2/package-r3e13r24/AmazMe Python 0.1.0` |
| B build_id | `7f4e9d802bbe1be8a96748bfdd89bf677bf09811e44398a12b6c8bbbd143b2fb` |
| 矩阵报告 | `/tmp/am2-uphi4eyo/report.json`（本地，不进 Git） |
| 浏览器报告 | `.artifacts/python-backend-p2/client-xzj9q131/report.json` |
| 这两份安装包 | 本机 ad-hoc onedir，不是已签名公证的 DMG |

`d5cefaf` 之后的源码改动不在 A/B 里。那些安装包不能为新能力背书。修复前的 wheel/sdist 也不再当作当前源码的构建证据；当前源码需重新 `uv build`。

## 1. P2 代码和协议

协议是 `amazme-http/1`。存储格式是 2。产品版本是 0.1.0。`build_id` 单独标识一次构建。

| 用户操作 | 入口 | 状态 | 自动测试 / 运行 | 证据 | 未通过与下一步 |
| --- | --- | --- | --- | --- | --- |
| 创建会话、排队、引导、忙时拒绝、取消 | `POST /api/v1/sessions`，`/submissions`，`/cancel`；Web 提交方式 | 已通过 | `backend/tests/test_session_p2.py`；矩阵里的取消与审批用例 | A/B，34 项矩阵 | 无 |
| 继续会话、重连、预览与持久结果一致 | `GET /snapshot`，`WS /api/v1/events` | 已通过 | `backend/tests/test_streams_p2.py`；`verify_client.py` 6 项 | Chrome 155，报告见上 | 新 Web 功能还没有进这次浏览器报告 |
| 后台子工作、定时唤醒、审批 | worker `/submissions`，`/approvals` | 已通过 | `test_session_p2.py`；`children.*`，`scheduled.worker_crash`，`approval.auto`，`approval.wait` | 矩阵 | 无 |
| 相同 ID 重试不重复副作用；内容冲突拒绝 | 提交与效果核对 | 已通过 | `test_storage.py`，`test_session_p2.py` | 单测 + 矩阵 | 无 |
| 未知调用不盲目重放 | `POST /effects/resolve` | 已通过 | `test_execution_p2.py`；矩阵核对步骤 | 矩阵 | 无 |
| 业务终态晚于清理证明；旧 epoch 未清理不授权新执行 | 监督器清理回执 | 已通过 | `children.cancel_descendants`，`cleanup.unavailable` | 矩阵 | 无 |
| spawn 前登记；停止证明不足保持 blocked | 监督器 | 已通过 | `supervisor.*` 八点：`create_intent`，`created`，`registered`，`started`，`before_permit`，`permitted`，`result`，`closed` | 矩阵。`supervisor.*` 同时杀掉 worker 和监督器 | 无 |
| worker 各提交窗口崩溃后不重复外部效果 | worker | 已通过 | `worker.model_intent`，`model_result`，`tool_intent`，`tool_result`，`decision`，`cleanup` | 矩阵 | 无 |
| 只读快照在重启预算耗尽时返回该事实且不创建 worker | `GET /snapshot` | 已通过 | `test_lifecycle.py::test_exhausted_session_budget_is_reported_without_spawning`；`workers.restart_budget` | 源码 `host.py` reader；矩阵 | 无 |
| 监督器关闭不持控制锁等待仍要该锁的 worker | `POST /control/shutdown` | 已通过 | `test_execution_p2.py::test_shutdown_releases_control_before_waiting_for_a_worker`；矩阵 `approval.wait` 的停止 | 源码 `supervisor.py` shutdown | 无 |
| 旧 Host 的迟到停止不能跨代 | 接管 | 已通过 | `host.takeover_stale_stop`，`host.lost_delivery` | 矩阵 | 无 |
| stopping/unknown 参与者不被新实例覆盖后遗漏 | 更新名册 | 已通过 | `update.roster`；`test_lifecycle.py` 名册测试 | 矩阵 | 无 |
| 同版本不同 build_id 的冻结、验证、激活 | `POST /control/updates/*` | 已通过 | `update.freeze`，`prepared`，`health`，`complete_crash`，`roster` | A 与 B | 验证 worker 不跑模型和业务工具，由冻结探针覆盖 |
| 重启不自动解除未完成更新 | Host 启动 | 已通过 | `test_lifecycle.py` 更新屏障重启用例 | 单测 | 无 |
| 慢客户端不阻塞持久提交 | WebSocket | 已通过 | `test_streams_p2.py`；`host.pause_delivery`；`events.ack_resync` | 矩阵 | 无 |
| 被替换的安装文件拒绝 ready | 启动 | 已通过 | `bundle.replaced_file` | 只改克隆 | 无 |
| 存储提交窗口崩溃 | worker | 已通过 | `storage.commit_crash` | 矩阵。SQLite FULL 另有单测，不等于磁盘写满 | 无 |
| Linux shell、读文件、写文件 | faux/真实模型工具，监督器执行 | 部分通过 | P1 `verify_runtime.py` / `verify_web.py`；P2 矩阵里的 shell 后代 | A/B 的 faux 路径 | 符号链接、硬链接、并发写和多工作区未做 |
| 从已完成的根任务分支，上下文此后隔离 | `POST /api/v1/sessions/{id}/branches`；会话里的「从此处分支」 | 部分通过 | `backend/tests/test_session_branch.py` | `0b73c8262a17982893326e07ca9a4ad15bb2e7de` 的单测和 happy-dom。不在 A/B 包内 | 还没用打包后的真实 Chrome 点这次分支。父会话历史在子会话继续后保持不变，由该测试覆盖 |

矩阵命令：

```bash
backend/.venv/bin/python backend/tools/verify_p2.py \
  --executable "$P2_A" --target-executable "$P2_B" --case all
```

34 项全部 `passed`，没有 `failed`、`not_run`、`skipped`。共享 profile 和审批 profile 的停止、删 VM、进程租约退出通过。`vm.force_stop` 只证明 VM 强停，不证明宿主断电。

## 2. P2 环境

| 用户操作 | 入口 | 状态 | 运行 | 证据 | 未通过与下一步 |
| --- | --- | --- | --- | --- | --- |
| 隔离卷真实写满时，已接纳请求还在，失败的那次没有落下 | `backend/tools/verify_enospc.py --output <报告>` | 已通过，只证明 2MiB HFS+ 镜像上的文件系统 ENOSPC | 当前源码跑过。失败码 `storage_failure`，消息是 `database or disk is full`，写满后可用块为 0，`max_page_count` 仍为 4294967294 | 本地报告不进 Git。已接纳的 `kept` 还在，失败的那次请求不在 | 不证明 SQLite 页数上限、VM 强停、睡眠或断电。睡眠仍用 `capture_wake.py`，现在是未验收 |
| SQLite 页数上限触发 FULL | 单测把 `max_page_count` 收到当前页数 | 已通过，范围仅限页数上限 | `test_storage.py::test_sqlite_full_rolls_back_receipt_and_batch_and_latches` | 单测 | 不能写成磁盘写满 |
| 宿主睡眠后唤醒，已接纳数据仍在 | `backend/tools/capture_wake.py` | 未验收 | `--prepare` 只写场景 | `test_environment_evidence.py` 确认 prepare 不会标通过 | 用户自行睡眠并唤醒后，`--record` 再打开原 profile 核对。脚本不会让机器睡眠 |
| 物理断电 | 无安全入口 | 未验收 | 不跑 | 无 | 不关机、不断电。取不到就保持未验收 |

## 3. P3 产品与客户端

参考协议名不等于该认证已经可用。下面未列出的供应商、OAuth、图片和分类都还没实现。占位错误不算完成。

| 用户操作 | 阶段 | 入口 | 状态 | 测试 / 运行 | 未通过与下一步 |
| --- | --- | --- | --- | --- | --- |
| 文本、工具流、终止与 faux usage | P1/P2 | `providers.stream`，faux 与 DeepSeek Flash | 部分通过 | faux 单测；P1 有一次真实 DeepSeek | 推理签名、缓存、费用和其余供应商未做。真实供应商只用已经授权的凭据 |
| 模型目录、选择、自定义端点、代理和请求头 | P3 | `GET/POST /api/v1/models`；侧栏模型表单 | 部分通过 | `backend/tests/test_model_catalog.py` | `0e9053cd`。目录是 faux 与 DeepSeek。DeepSeek 可改 https 端点。代理密码不进回执和会话记录。请求头有数量和名称限制。OAuth 未做 |
| API key | P1 | `provider.json`，不进普通日志 | 部分通过 | 配置加载 | 刷新、轮换和登出竞争未做 |
| OAuth、单一刷新管理者、取消期间 token 落盘 | P3 | 无 | 未通过 | 无 | 按供应商要求的 client ID、回调和请求身份实现。缺账号时保持未验收并继续无关功能 |
| 图片、分类 | P3 | 无 | 未通过 | 无 | 按产品里实际有的能力做，不按枚举注册名称 |
| 会话归档 | P3 | `POST /api/v1/sessions/{id}/archive`；页面「归档 / 恢复」 | 部分通过 | `test_session_branch.py` 的归档用例和 happy-dom | `1af60222`。不在 A/B 安装包里，也还没有真实 Chrome。历史不删除；未开始的任务变为已取消 |
| 上下文压缩、过期结果拒绝、压缩失败保留原历史 | P3 | `POST /api/v1/sessions/{id}/compactions`；页面「压缩上下文」 | 部分通过 | `test_session_branch.py` 的压缩用例和 happy-dom | `8c9cee19`。摘要走当前供应商。依据不一致拒绝写入。失败不删原消息。还不在 A/B 包和真实 Chrome 里 |
| 切换会话 | P2 Web | 侧栏 | 已通过 | `verify_client.py` 的 A-B-A | 分支后的切换有 happy-dom 测试，还没有进 Chrome 报告 |
| 文件浏览、编辑、diff、受检写入 | P3 | 现在只有 VM 里的 `read_file` / `write_file` | 部分通过 | P1 工具路径 | 浏览、diff、符号链接、硬链接、权限和并发写未做 |
| 多工作区与统一路径映射 | P3 | init 只有一个 workspace | 未通过 | 无 | 显式宿主/guest 映射。不默认挂载 HOME、钥匙串或 SSH agent |
| PTY、终端输入、resize、输出背压 | P3 | 无 | 未通过 | 无 | Linux PTY，经监督器 |
| 工作区持久依赖卷和固定工具镜像 | P1 资源 / P4 分发 | 构建期离线镜像 | 部分通过 | P1 运行记录 | 运行时不临时拉镜像。完整离线首启属 P4 |
| SSH / 远端 daemon | P3 | 无 | 未通过 | 无 | 断线不把远端判成已停止 |
| MCP 连接、目录、审批、取消 | P3 | 无 | 未通过 | 无 | MCP 不能代替其他插件能力 |
| Codemode 受控 JS | P3 | 无 | 未通过 | 无 | 不暴露任意宿主文件和网络 |
| 已批准的原生桌面动作 | P3 | 无 | 未通过 | 无 | 独立驱动，并证明退出和资源归属。不做任意 macOS shell |
| 插件身份、配置、入口、受管生命周期 | P3 | 无 | 未通过 | 无 | 插件不能写 SQLite，也不能绕过监督器 |
| history / memory、checkpoint、automation、workflows、web 工具、computer-use | P3 | 无 | 未通过 | 无 | 按方案第 6.3 节逐项做。付费调用不盲目重放 |
| 项目、设置、搜索、反馈、分享、artifact、模型管理、导入导出 | P3 | 无 | 未通过 | 无 | 只处理新格式。不读旧 TS 数据 |
| 使用量、费用、诊断；日志不漏凭据 | P3 | 健康与错误码 | 部分通过 | 预算耗尽快照测试 | 费用和诊断面未做。凭据继续不进普通日志 |
| Web 完整产品 | P3 | `backend/src/amazme_backend/web` | 部分通过 | `verify_client.py` 6 项；分支按钮有 happy-dom | 管理面、分支的真实 Chrome、多窗口还没做 |
| Electron 启动包内 Python、配对、退出、更新 | P3/P4 | 现有 `packages/gui` 仍接旧后端 | 未通过 | 无 | 包内后端、握手、关窗口不杀共享工作、显式退出才停本次服务 |
| CLI 与非交互 | P3 | `amazme-backend` 的 init/serve/pair/stop/destroy-vm | 部分通过 | 矩阵使用这些命令 | 不是产品 CLI。输出要断言内容 |
| RPC | P3 | 无 | 未通过 | 无 | 新契约，显式宿主、会话和工作区 |
| 异步 SDK | P3 | 无 | 未通过 | 无 | 释放绑定不等于取消任务 |
| TUI | P3 | 现有 TUI 仍接旧后端 | 未通过 | 无 | 桌面宽窗。至少一次真实会话操作 |
| 多窗口、多宿主、绑定代际 | P3 | Web 有 A-B-A 草稿测试 | 部分通过 | `test_streams_p2.py` 的所有权测试；`verify_client.py` | Electron/TUI/远端还没有 |

## 4. P4 交付

| 用户操作 | 状态 | 入口 | 未通过与下一步 |
| --- | --- | --- | --- |
| 移动安装目录、路径含空格、受控 PATH、离线首次启动 | 部分通过 | P1 onedir 记录 | 最终树还要重做。不依赖系统 Python、Node、Colima、Docker CLI |
| 构建身份覆盖代码、依赖、插件、helper 和执行资源 | 部分通过 | `build_id()` 覆盖当前 bundle 文件 | 插件和 helper 还没有 |
| 桌面私有更新衔接冻结、验证、激活 | 部分通过 | 后端更新协议已在矩阵通过 | Electron 尚未调用它 |
| Developer ID、hardened runtime、公证、staple、Gatekeeper | 未验收 | `packages/gui/README.md` 的本机步骤。禁止 `npm run release` | 用本机已有凭据。缺哪一项就记哪一项，不用 ad-hoc 顶替 |
| Linux 宿主组合 | 未验收 | 无本机环境记录 | 没有环境就保持未验收 |
| 冷/热启动、RSS、提交延迟、事件规模、历史加载、取消到真实退出 | 未验收 | 无 | 最终安装产物上测量 |
| 删除旧 TS 业务依赖 | 未通过 | TS 源码仍在，作为呈现和参考 | 替代路径通过且无引用之后再删。保留仍有用的 UI、客户端运行时和受控 JS helper |

## 下一步

1. 当前源码已重新 `uv build`。Ruff、Pyright 和 pytest 294 通过。A/B 安装包仍是 `d5cefaf`，不覆盖这次分支。
2. 模型目录已能保存端点、代理和请求头。OAuth 仍未做。
3. 睡眠和断电保持未验收。ENOSPC 只证明 2MiB 隔离卷。
