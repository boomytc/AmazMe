# Python 后端重构验收台账

日期：2026-10-24。分支 `dev`。本文件按用户能完成的操作记录状态，并随实现更新。四类状态分开，不能互相冒充：

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

`9b83b083` 又打了两份包并重跑同一条 `--case all`。摘要是 `docs/python-backend-head-p2.json`。A 是 `.artifacts/python-backend-head/package-yboxdh3i`，build_id `f3b24e92d590c7343c3d04a76b48e2dffe6d0e2142edb45980e74d56805c0cd8`。B 是 `package-4qxl9x82`，build_id `a9667286a889153a1d55d77d6e39c529d867a60d8d4b7a89868fc2b7e30be331`。34 项都是 `passed`，清理是 `passed`。同一份 A 上的 Chrome headless `verify_client.py` 6 项通过，页面错误为空，报告是 `.artifacts/python-backend-p2/client-jwdc18bu/report.json`，浏览器 155.0.8059.85。这两份仍是本机 ad-hoc onedir，不是公证 DMG。早先 `d5cefaf` 的 A/B 记录仍然有效，不拿这次覆盖那次的 build_id。

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
| 文件浏览、编辑、diff、受检写入 | P3 | `GET /api/v1/files`、`GET/POST /api/v1/files/content`；页面「工作区文件」 | 部分通过 | `backend/tests/test_workspace_files.py`；`test_boundaries.py` 会执行客户机脚本 | `0ebbe95` 页面按摘要写入。`9e2defe` 的客户机 `read_file` / `write_file` 拒绝越界符号链接、符号链接目录和硬链接，但工具写入仍不要求摘要，也会补齐缺失的父目录。多工作区映射见 `efbda5d`。这些提交都不在 A/B 安装包里 |
| 多工作区与统一路径映射 | P3 | `POST /api/v1/workspaces`；页面「工作区文件」 | 部分通过 | `backend/tests/test_workspaces.py` 授予目录、读写文件、工具命令和终端 cwd | `efbda5d`。主目录仍是 `/workspace`。额外目录显式授予后固定为 `/grant/名称`，文件接口、工具根和终端 cwd 使用这条路径。用户主目录、`.ssh`、钥匙串、profile 和 `docker.sock` 不能授予。取消授予不删目录里的文件。还没有在 Lima 里挂载验证，也不在 A/B 包里。shell 工具仍从 `/workspace` 启动 |
| PTY、终端输入、resize、输出背压 | P3 | `POST /api/v1/sessions/{id}/terminals`；页面「终端」 | 部分通过 | `backend/tests/test_pty.py` 会执行客户机脚本，并经监督器打开同一条命令 | `6dcdc47`。输出超过窗口后不再转发，直到客户端授信。退出码只来自 waitpid，连接断开保持 unknown。容器规格无网络、不分配 Docker TTY。本机测试直接跑该 PID 1 脚本，没有在 Lima 里再跑一遍。Docker 桥接代码未对真实 daemon 验收 |
| 工作区持久依赖卷和固定工具镜像 | P1 资源 / P4 分发 | 构建期离线镜像 | 部分通过 | P1 运行记录 | 运行时不临时拉镜像。完整离线首启属 P4 |
| SSH / 远端 daemon | P3 | `POST /api/v1/sessions/{id}/remotes`；页面「远端」 | 部分通过 | `backend/tests/test_remote.py` 启动 `remote_daemon.py` 并经监督器连接 | `81b0186`。核对主机密钥、daemon 内容和代际。本地断开后阶段是 disconnected 或 blocked，不是已停止。未知调用不重放，代际不符时挡住新命令。这不是一次真实 OpenSSH 到远端主机的会话 |
| MCP 连接、目录、审批、取消 | P3 | `POST /api/v1/sessions/{id}/mcp`；页面「MCP」 | 部分通过 | `backend/tests/test_mcp.py` 执行客户机脚本，并经监督器打开同一条命令 | `7719860`。stdio 服务在客户机里。目录来自 tools/list。调用先落成等待批准，批准后才转发，同一 ID 的不同参数冲突。停止后的退出码来自 waitpid，清理失败会挡住下一个 MCP。OAuth 未做。本机没有在 Lima 里再跑。MCP 不代替其他插件 |
| Codemode 受控 JS | P3 | `POST /api/v1/sessions/{id}/code`；页面「脚本」 | 部分通过 | `backend/tests/test_codemode.py` 运行 QuickJS helper、监督器提交/取消，以及页面脚本 | `6319c3f`。成功才提交状态。失败、超时、取消和没有退出证明都不提交。没有 waitpid 时，同一会话不能再开新脚本，同一 run id 不重放。已发生的工具副作用不回滚。helper 是本机 node 上的固定 QuickJS 程序，没有放进 Linux 客户机，也不在 A/B 安装包里。不暴露任意宿主文件和网络 |
| 已批准的原生桌面动作 | P3 | 无 | 未通过 | 无 | 独立驱动，并证明退出和资源归属。不做任意 macOS shell |
| 插件身份、配置、入口、受管生命周期 | P3 | `POST /api/v1/plugins`、`GET /api/v1/plugins`；页面「插件」 | 部分通过 | `backend/tests/test_plugins.py` 运行固定入口，并经监督器登记、调用和重新加载 | `268556a`。打开插件面板会读取已保存的插件，`244820e`。入口只有 stamp，由监督器启动，许可里没有命令或 SQLite。同一调用不重复写入，内容冲突拒绝。没有退出证明时不能再调用。worker 还持有旧插件指纹时不能更换。定时等待等未结束任务会挡住登记和重新加载，原任务文本保留。这不是 MCP。入口还没放进 Linux 客户机，也不在 A/B 包里 |
| 历史搜索 | P3 | `GET /api/v1/sessions/{id}/search`；页面「历史」 | 部分通过 | `test_session_branch.py` 的搜索用例和 happy-dom | `6fc70d5`。只查当前会话已落盘的任务文本和消息。`%` 按字面匹配。归档后仍可搜。不注入记忆，也不搜索其他会话。还不在 A/B 包和真实 Chrome 里 |
| 记忆发现与上下文注入 | P3 | `POST /api/v1/memories`；页面「记忆」 | 部分通过 | `backend/tests/test_memories.py` 保存记忆，并由 `Worker.perform` 注入模型输入 | `da0240c`。记忆按工作区保存。只有与用户原文相配、且属于该会话工作区的记忆会放进模型上下文。同一 ID 的不同内容冲突，原文保留。匹配是子串，不是语义检索。还不在 A/B 包里 |
| 文件检查点、预览和选择性恢复 | P3 | `POST /api/v1/checkpoints`；页面「保存检查点 / 预览 / 恢复」 | 部分通过 | `backend/tests/test_checkpoints.py` 写入前备份、预览不改文件、按摘要恢复 | `25fc14e`。受检写入前记下原内容。预览只给出差异。恢复只改这一条路径，且必须对上当前摘要；不符则磁盘内容不变。客户机里的 `write_file` 还不会自动产生检查点。还不在 A/B 包里 |
| 定时任务、时区与去重 | P3 | `POST /api/v1/automations`；页面「定时」 | 部分通过 | `backend/tests/test_automations.py` 拒绝夏令时缺口和含糊时刻，并检查调度只提交一次 | `189a130`。到期时刻来自 IANA 时区。2026-03-08 02:30 纽约时间被拒绝。2026-11-01 01:30 必须指定 fold，两次相差一小时。同一 ID 的不同内容冲突。到期后只在一次事务里写提交回执；会话已归档则记为未知且不再提交。这是一次性时刻，不是周期规则。还不在 A/B 包里 |
| 工作流：独立检查、有限修正、阶段恢复、子上下文、父子取消 | P3 | `POST /api/v1/sessions/{id}/workflows`；页面「工作流」 | 部分通过 | `backend/tests/test_workflows.py` 用 faux 跑子任务，并经页面提交所选会话 | `e9bb34e`。检查和修正各是独立子任务，不复制父会话消息。未通过时最多再开修正上限那么多次；同一结论重复提交不再开子任务，不同内容冲突。恢复只读已落盘的阶段。取消工作流会取消子任务；只取消子任务不会取消工作流，也不会补一个新的。归档会取消尚未结束的工作流。这不是通用阶段图，也没有命令检查或阶段内并发。还不在 A/B 包里 |
| 网页搜索和抓取 | P3 | `POST /api/v1/sessions/{id}/web` 与 `/web/calls`；页面「网页」；模型工具 `web_search` / `web_fetch` | 部分通过 | `backend/tests/test_web_tools.py` 用本地假响应跑页面调用，并用 faux 回合驱动 `Worker.perform` | `4d30ac2` 是页面调用。`42db378` 让模型工具留在会话 worker，不打开客户机。打开面板读取已保存策略在 `97f8fe6`，再次保存不退回默认端点。默认关闭。只发送已保存的 DeepSeek API key，不转发聊天端点、代理、附加请求头，也不接受调用里的端点或密钥。策略关闭或没有 key 时不发请求，也不占用调用 ID。响应超过上限，或连接在请求发出后中断，记为未知并且同一个调用不再发送。明确的 HTTP 失败和重定向也不重发，且不跟随重定向。不读取环境变量里的 key。成功时工具结果写入会话，页面上的回答就是这份结果。没有真实付费调用。分支不会复制这份设置。还不在 A/B 包里 |
| 桌面观察、坐标、新鲜度和清理 | P3 | `POST /api/v1/sessions/{id}/computer`；页面「桌面」 | 部分通过 | `backend/tests/test_computer_use.py` 运行固定驱动脚本 | `fe73248`。默认关闭。驱动报告缺权限时不发点击，调用方不能自己声明已授权。方向 6、比例 2 的点 (1,4) 换成驱动像素 (8,16)；方向 1、比例 2 的点 (3,4) 换成 (6,8)。过期或被新观察替换的截图不会发出。第二个动作在前一个尚未回答时被拒绝。驱动在动作途中退出则保持未知，没有退出码就不会清理，清理后才能再观察。这不是 cua-driver，也没有读 macOS TCC 或操作真实桌面。未配置时驱动报告未授权。还不在 A/B 包里 |
| 项目、设置、反馈、分享、新格式导入导出 | P3 | `POST /api/v1/projects`、`/settings`、`/feedback`、`/sessions/{id}/shares`、`GET /sessions/{id}/shares/{id}`、`/export`、`/import`；页面「管理」 | 部分通过 | `backend/tests/test_management.py` 导出后再次导入，并拒绝旧格式和改过的摘要 | `b74e2d3`。打开管理面板会 GET 已保存的项目，`318ea95`。分享后会 GET 已保存的正文，`5de3d5c`。项目、显示名、反馈和分享在同一 ID 下内容冲突会保留原文。导出是 amazme-export/1，不附带供应商密钥、代理或请求头。导入不删除已有会话；摘要不符或旧格式被拒绝。会话里如果出现已保存的密钥，导出和分享会拒绝并且错误文本不含密钥。这不是公开链接，也不是文件 artifact 或用量账单。搜索和模型目录是分开的入口。还不在 A/B 包里 |
| 使用量、费用、诊断；日志不漏凭据 | P3 | 健康与错误码 | 部分通过 | 预算耗尽快照测试 | 费用和诊断面未做。凭据继续不进普通日志 |
| Web 完整产品 | P3 | `backend/src/amazme_backend/web` | 部分通过 | `verify_client.py` 6 项；分支按钮有 happy-dom | 浏览器地址没有写会话和工作区时，仍会选中列表第一项。Electron 窗口已经按地址分开，见下面一行。管理面和分支还没有在真实 Chrome 里再跑 |
| Electron 启动包内 Python、配对、退出、更新 | P3/P4 | `node packages/gui/dist/start.js`；`AMAZME_PYTHON_BACKEND` 或 `Resources/amazme-backend/amazme-backend` | 部分通过 | `packages/gui/test/python-desktop.live.test.ts` 用真实 Electron 入口把当前 onedir 拉起两次；`docs/python-backend-electron-launch.json` | `55b0173` 接上启动参数。`bef9f14` 把配对码写进该窗口的会话，并让关窗不调用退出。现场两次启动的 build_id 是 `5df74527eb72fdf034f4e3be2d9aef23a4393f8109d74506fbf3c8ed34b1f830`，宿主 pid 分别是 42463 和 42565。两次登录框都已隐藏。关窗后该 pid 仍在，明确退出后该 pid 消失，旁边的 sleep 进程还在。桌面更新在替换前用暂存包里的 build_id 冻结。源构建重启不激活。目标构建先验证再激活，现场在 `docs/python-backend-desktop-update.json`。没有 64 位目标 build 时不冻结。多窗口在 `6e0d96d`，报告是 `docs/python-backend-electron-windows.json`：包是 `package-fe7_msbu`，build_id `a44cf603121570ffcb1037fcb331ba3bb6b22d106555ddda367aa7157e41a73e`。真实入口拉起两次，每次两个窗口，工作区都是 primary，四个会话各不相同。关掉另一个窗口，再关掉持有等待任务的窗口，任务仍是 `waiting_time`，`cancel_requested` 为 false，宿主 pid 60666 和 61246 还在。明确退出后这两个 pid 消失，旁边的 sleep 还在。这不是已签名 DMG。还没有公证。 |
| CLI 与非交互 | P3 | `amazme-backend client` 的 create、submit、release、cancel、rpc。服务命令仍是 init、serve、pair、stop、destroy-vm | 部分通过 | `backend/tests/test_client.py`；`backend/tools/verify_frozen_clients.py` | `77101bd` 在源码入口上通过。`26ffe5e` 用冻结 onedir 再跑了同一组命令，build_id `6d4ba35edcfd8e8f7f00241883c168f70d87320eeff9a7f35ecd62b2164c7c47`，报告 `docs/python-backend-frozen-clients.json`。`submit` 的回答是 `已收到：你好`。松开绑定后旧绑定再写被拒绝。错工作区时 stderr 只有 `workspace_mismatch`。令牌不在输出里。这不是已签名 DMG，也没有覆盖文件或远端 |
| RPC | P3 | `POST /api/v1/rpc` | 部分通过 | 源码测试和 `verify_frozen_clients.py` 都打到这条路由 | `77101bd`。冻结包上的同一检查在 `26ffe5e`，build_id `6d4ba35edcfd8e8f7f00241883c168f70d87320eeff9a7f35ecd62b2164c7c47`。提交和取消要带工作区，不一致就拒绝并且不执行。`session.release` 只丢掉绑定。这不是已签名 DMG |
| 异步 SDK | P3 | `amazme_backend.sdk.Client`；冻结包里的 `client` 子命令走同一条实现 | 部分通过 | 同上 | `77101bd`。`26ffe5e` 里 SDK 对着冻结 serve 松开绑定，任务仍在等待，旧绑定再写得到 `stale_client_binding`。冻结 `client submit` 拿到 `已收到：你好`。这不是已签名 DMG |
| TUI | P3 | 默认 `amazme` 交互；`amazme-backend tui`；`--python-url` 与 `--python-token` 接到指定宿主 | 部分通过 | `backend/tests/test_tui.py`；`verify_frozen_clients.py`；`backend/tests/test_python_interactive.py`；`test/durable-main-startup.test.ts` | `ac0c7f1` 让默认交互不再打开旧 durable 界面。不带参数时从 PATH 的 `amazme-backend` 拉起或接上已有 Python 宿主，工作区是 primary，画面写出会话和绑定。Ctrl-C 后宿主还在，等待任务不取消，第二次输入得到 `已收到：你好`。已有 `config.json` 不会被清空。第一次 profile 用 faux。`--python-url` 和 `--python-token` 必须成对出现，用来连指定宿主。`AMAZME_DURABLE_TUI=1` 不在帮助里，只留给仍要跑旧界面的测试。默认的 `--print`、`--mode json` 和 `--mode rpc` 也走 Python：文本输出是 `已收到：你好`，JSON 带工作区和状态，RPC 转发到 `POST /api/v1/rpc`，松开绑定不取消等待任务。冻结 `tui` 又跑过一次，build_id 仍是 `6d4ba35edcfd8e8f7f00241883c168f70d87320eeff9a7f35ecd62b2164c7c47`，pid 是 32224 和 32263。这不是已签名 DMG |
| 多窗口、多宿主、绑定代际 | P3 | Web 有 A-B-A 草稿测试；两个 `amazme-backend tui` 对同一个 serve | 部分通过 | `test_streams_p2.py` 的所有权测试；`verify_client.py`；`test_tui.py` 的两个终端 | `eae6735`。两个终端同时在线时，离开一个不会取消另一个会话里的等待任务，留下的那个仍能看到 faux 回答。Electron 两个窗口在 `6e0d96d`，现场记录是 `docs/python-backend-electron-windows.json`。远端多宿主还没有 |

## 4. P4 交付

| 用户操作 | 状态 | 入口 | 未通过与下一步 |
| --- | --- | --- | --- |
| 移动安装目录、路径含空格、受控 PATH、离线首次启动 | 部分通过 | `backend/tools/verify_relocated_bundle.py`；`docs/python-backend-head-install.json` | `9b83b083` 的包 `package-yboxdh3i` 被复制到带空格的目录后，在 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` 时启动两次。build_id 仍是 `f3b24e92d590c7343c3d04a76b48e2dffe6d0e2142edb45980e74d56805c0cd8`，协议 `amazme-http/1`。两次 ready 是 2.959 秒和 1.297 秒，套接字只有 `127.0.0.1`，pid 14288 和 14412 已退出。同一份 seatbelt 里，连 `1.1.1.1:443` 得到 Operation not permitted，连 `127.0.0.1:9` 得到 Connection refused，然后这个进程完成了首次 init 和 serve。这是进程出站被拒绝，不是拔掉机器网线。`b76ad5d` 那次 `allow default` 的 seatbelt 拦不住 https://example.com，那次离线结论作废。还没有覆盖会调用系统 Python、Node、Colima 或 Docker CLI 的路径，也还不是最终公证包。 |
| 构建身份覆盖代码、依赖、插件、helper 和执行资源 | 部分通过 | `build_id()` 覆盖当前 bundle 文件 | 插件和 helper 还没有 |
| 桌面私有更新衔接冻结、验证、激活 | 部分通过 | `9f2cd64` 的 `packages/gui/src/main.ts` `settlePythonUpdate`；`packages/gui/test/python-update.live.test.ts`；`docs/python-backend-desktop-update.json` | 源包 `package-fe7_msbu` build `a44cf603121570ffcb1037fcb331ba3bb6b22d106555ddda367aa7157e41a73e` 冻结后 `activated` 为 false。同一源构建再次启动仍不激活，提前 complete 是 `update_target_mismatch`。目标包 `package-syyayj_m` build `0169b95e3e5f724e096d7a7fae3b5cf47c517c44d9ee41b097664514db9df06b` 先得到 `validation` 用途的验证 worker，再激活。之后健康状态是 ready，提交回答是「已收到：更新后」。这不是已签名 DMG，也没有走公证后的安装器替换。 |
| Developer ID、hardened runtime、公证、staple、Gatekeeper | 未验收 | `packages/gui/README.md` 的本机步骤。禁止 `npm run release` | `~/.config/amazme/release.env` 里的团队 ID、Key ID、Issuer ID 和 p8 路径都有值，Issuer 是 UUID，Key ID 只有字母数字，p8 文件在。钥匙串里有 2 个 Developer ID Application，没有一个属于这份配置里的团队。不能改用别的团队顶上。还没有签名产物 |
| Linux 宿主组合 | 未验收 | 无本机环境记录 | 没有环境就保持未验收 |
| 冷/热启动、RSS、提交延迟、事件规模、历史加载、取消到真实退出 | 部分通过 | `b64769e` 的 `backend/tools/measure_runtime.py`；`docs/python-backend-runtime-timing.json`；ready/RSS 另见 `docs/python-backend-relocated.json` | 包 `package-fe7_msbu`，build_id `a44cf603121570ffcb1037fcb331ba3bb6b22d106555ddda367aa7157e41a73e`。冷提交到回答可见 10.748 秒，POST 返回时状态仍是 queued。随后 8 次的 POST 是 0.0035 到 0.0055 秒，再过 0.026 到 0.029 秒能读到「已收到」。快照 0.0087 秒，9 个请求、70 个事件、28932 字节。搜索「历史条目」0.0069 秒，50 条命中、5965 字节。`/shell sleep 120` 处于 running 时取消，0.124 秒后回执是 cancelled 且 `cancel_requested` 为 true；再过 0.165 秒，取消前看到的客户机容器已不在 `docker ps`。宿主上没有单独的 sleep 进程。ready 两次是 4.104 秒和 1.364 秒，RSS 174144 KB 和 173840 KB，只含宿主和监督器。这不是最终安装产物上的曲线。 |
| 删除旧 TS 业务依赖 | 未通过 | `docs/python-backend-ts-deps.md` | Python `backend/src` 不导入 TypeScript。`AMAZME_DURABLE_TUI=1` 仍会打开旧交互、打印和 RPC。桌面端找不到 Python 后端时仍会跑 `@amazme/coding-agent` 的 `bundle/cli.js`。这些入口还有引用，所以不删。呈现、TUI 组件和受控 JS helper 保留。 |

## 下一步

1. 工作区文件浏览和受检写入在 `0ebbe95`，客户机文件工具的链接约束在 `9e2defe`。后者的 Ruff、Pyright 和 pytest 312 通过。A/B 安装包仍是 `d5cefaf`。
2. 默认 `amazme` 的交互、`--print`、`--mode json` 和 `--mode rpc` 都走 Python 宿主。文本回答是 `已收到：你好`，JSON 带工作区和状态，RPC 转发到 Python，松开绑定不取消等待任务。`--python-url` 和 `--python-token` 成对使用时连到指定宿主。`AMAZME_DURABLE_TUI=1` 只留给旧测试。冻结 onedir `package-5xggd2k2` 的 build_id 是 `6d4ba35edcfd8e8f7f00241883c168f70d87320eeff9a7f35ecd62b2164c7c47`。`26ffe5e` 在这上面重跑了命令行、RPC、SDK 和终端，报告是 `docs/python-backend-frozen-clients.json`。Electron 多窗口在 `6e0d96d`，现场记录是 `docs/python-backend-electron-windows.json`，build_id `a44cf603121570ffcb1037fcb331ba3bb6b22d106555ddda367aa7157e41a73e`，宿主 pid 60666 和 61246。每个窗口的地址写明自己的会话和 primary 工作区。关掉窗口后等待任务仍是 waiting_time。两个终端同时在线的隔离在 `eae6735`。命令行、JSON-RPC 和异步 SDK 在 `77101bd`。真实 `python -m amazme_backend serve` 上，松开绑定不取消等待任务，错工作区被拒绝，命令行提交得到 faux 回答。还没有在冻结 onedir 里跑这组命令。桌面用真实 Electron 入口把包内 Python 拉起两次的记录在 `bef9f14`，build_id `5df74527eb72fdf034f4e3be2d9aef23a4393f8109d74506fbf3c8ed34b1f830`。还没有公证。项目列表读取在 `318ea95`，分享正文读取在 `5de3d5c`，项目、反馈、分享和导入导出在 `b74e2d3`。OAuth 仍没有消费者。模型网页工具在 `42db378`，打开面板读取策略在 `97f8fe6`，仍没有真实付费调用。桌面观察在 `fe73248`，用的是固定协议驱动，不是 cua-driver，也没有真实 TCC。网页搜索和抓取的页面调用在 `4d30ac2`。工作流在 `e9bb34e`。定时任务在 `189a130`。文件检查点在 `25fc14e`。工作区记忆注入在 `da0240c`。多工作区路径映射在 `efbda5d`。插件登记和受管入口在 `268556a`，打开面板读取已保存插件在 `244820e`。当前会话历史搜索在 `6fc70d5`。Codemode 在 `6319c3f`。远端 daemon 在 `81b0186`。MCP 在 `7719860`，终端 PTY 在 `6dcdc47`。这几项都还没有真实 Linux/OpenSSH 验收。OAuth 未做。插件入口、额外工作区和客户机文件检查点都还没在 Lima 里验收。工作流还不是通用阶段图。
3. 睡眠和断电保持未验收。ENOSPC 只证明 2MiB 隔离卷。`9b83b083` 的含空格路径、受控 PATH 和进程级离线首启在 `docs/python-backend-head-install.json`。那次证明的是 seatbelt 拒绝公网 TCP，不是机器断网。
4. 公证凭证文件在，但钥匙串里的 Developer ID Application 都不属于 `release.env` 里的团队。签名停在这里，不用 ad-hoc 或别的团队代替，也不运行 `npm run release`。Pyright 在 `20c145f` 之后是 0 错误。
