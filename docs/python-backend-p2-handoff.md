# Python 后端 P2 阶段交接（2026-10-23）

## 当前结论

用户因 Codex 额度要求尽快阶段收口。P2 的持久化、生命周期和验收工具已实现，经过分模块交叉审查及修复；**完整 P2 尚未验收完成**。下一位 agent 应接着验证、修复现有实现，不重新设计、不开始 P3。

仓库 `/Users/boom/workspace/AmazMe`，日常分支 `dev`。本轮起点为 P0/P1 提交 `e3c791039d6823e43fd23863e00356882621af18`。本文件随 P2 阶段提交保存，提交范围是实现和关键三项验收，非完整 P2 验收；以 `git log -1` 取得提交哈希。本轮没有推送、标签或 Release。

范围保持全新产品线 `0.1.0`、唯一 `build_id`、新格式 2 profile；不兼容或迁移 P1 格式 1 和旧 TS 数据。旧 TS 源码、版本和客户端保留。P2 使用 faux 确定性模型验证，不读取旧 DeepSeek 凭据，不消耗模型 API。

## 已实现与审查修复

| 入口 | 责任和当前实现 |
| --- | --- |
| `backend/src/amazme_backend/host_store.py`、`host.py` | Host 持久 outbox、调度需求、代际接管、参与者台账、冻结/验证/激活更新协议 |
| `storage.py`、`session_domain.py`、`worker.py` | 独占会话 SQLite、请求去重、排队/引导/拒忙、审批、必要子工作、定时唤醒、检查点恢复、取消与未知结果 |
| `supervisor.py`、`processes.py` | spawn 前登记及内核生命周期租约、所有 worker 历史实例、执行 epoch、恢复预算、未知副作用与清理屏障 |
| `vm.py`、`docker_channel.py`、`gate.py` | 固定 Lima/VZ 和 Linux 容器、监督器直连许可通道、容器后代终止、VM 停止证明 |
| `streams.py`、`web/`、`contracts.py` | 完整事务批次、ACK/重放/重同步、有界背压、全量未结事项快照、生成 JSON/TS/OpenAPI |
| `faults.py`、`tools/verify_p2.py` | 隔离 test-mode 文件 rendezvous，真实进程 SIGKILL、VM 和 WebSocket 故障矩阵 |

审查已修复：Host 丢 ACK 后采纳和重投、不可变进程身份、stopping 实例禁止复用、验证 worker 禁止业务执行、验证空 epoch 的清理证明校验、取消期间只结算历史事实、重复核对同一未知调用、取消墓碑覆盖成功结果、深层子工作挤掉根请求结果，以及数据库删除/替换/格式错误的写入前拒绝。

运行中另发现并修复四类问题：

1. Lima 按不存在实例查询返回非零；改为读取完整清单再按精确名称和目录匹配，删除缺失实例保持幂等。
2. Lima 长驻 hostagent 继承 operation 锁导致无法停止；固定源码补丁在 CLI→hostagent 启动窗口传递租约，Running 后只关闭启动副本，后续 exec 不继承。不能简单提前释放锁，否则重新引入派生到登记窗口。
3. Lima SSH 临时 socket 带 16 字符后缀；VM HOME 缩短为 `$HOME/.amazme-vm/<profile-sha24>`，在写任何归属元数据之前按字节检查最长路径 `<104`。有 103/104/111 字节及 Unicode 回归。
4. Host 崩溃接管复用原端口时，未设置地址复用，TCP TIME_WAIT 导致 `EADDRINUSE`；改为标准库 `socket.create_server`，不启用 REUSEPORT。真实 socket 回归先复现失败，再验证端口重建成功且不能与活跃监听器共享端口。失败原包报告 `/tmp/am2-vs4iztsv/report.json` 保留；其 CLI 清理失败，运行器按身份退役全部自建进程并删除 VM，不能把兜底清理算成正常退出通过。

这些约束主要落在代码边界和状态不变量，测试覆盖进程崩溃及外部组件行为，未依赖新增文字规则防错。

## 已取得证据

- 最后源码检查：wheel/sdist 构建成功；Ruff 通过；Pyright 0 错误；**284 项 pytest 通过**。日志 `.artifacts/python-backend-p2/phase-tests-final.log`。测试包括真实 SQLite FULL、真实子进程 SIGKILL/租约、事务提交前崩溃、真实 TCP 监听端口恢复，以及领域、IPC 和客户端 reducer 回归；不等于完整 VM 故障矩阵。
- `npm run check:workspace` 已通过；未运行根目录完整 npm build/test。
- 原生 Lima 启停实验通过：`.artifacts/python-backend-p2/native-vm-ng7luid_/report.json`，包含真实 VM 启动、Running 后变更锁可重新取得、guest boot_id、停止和删除。
- 较早安装包 `c06833d79e69d9099deac3991b52daa4cfcb87badd6f803f846d48349c322169` 在 `/tmp/am2-kl6uvmmz/report.json` 中通过 `host.lost_delivery`：Host SIGKILL 后同 ID 重投，工作区只出现一次实际写入，原接受回执和事件不重复，epoch 清理证明完整。随后事务崩溃用例遇到恢复期 `503 worker_identity_mismatch`，整组报告为 failed，WS 用例未跑；最终服务停止、VM 删除和所有租约退出检查通过。
- 该 `503` 是 reader 在旧 worker 已退出或新 worker 尚未登记完整时拒绝读的响应。运行器现仅在有上限的读轮询中重试该响应；持续身份错误仍会超时失败，未放松产品身份校验。

**最终安装包关键三项全部通过，清理全部通过**，报告 `/tmp/am2-8ei0wbd3/report.json`，运行日志 `.artifacts/python-backend-p2/matrix-phase-closed.log`：

| 实际运行用例 | 通过的关键断言 |
| --- | --- |
| `host.lost_delivery` | 杀死 Host 后保持原接受回执；重投只有一次真实 VM 文件写入、一个接受事件及一份工具结果；执行 epoch 取得精确清理证明 |
| `storage.commit_crash` | Worker 在 COMMIT 前被杀；另一 SQLite reader 看不到未提交回执、工作区无提前副作用；Host 持久意图恢复后仅接受/写入一次 |
| `events.ack_resync` | 未 ACK 订阅者不阻塞后台任务；慢连接被有界断开；重连按完整事务重放；越界 ACK 拒绝；错误游标重取权威快照 |

最终报告还确认 CLI stop 成功、VM 删除、全部登记进程租约真实释放。可随 Git 传递的断言名称、build_id 和原报告摘要见 [阶段证据](python-backend-p2-phase-evidence.json)。完整矩阵剩余 28 项、浏览器和双构建更新不能依据这些局部证据标记通过。

## 固定构建与原生资源

当前包含最终路径检查及监听端口修复的本机安装目录：

```text
/Users/boom/workspace/AmazMe/.artifacts/python-backend-p2/package-elc1r9vp/AmazMe Python 0.1.0
build_id: 97834ab4d684f5f970a14550f42a02995aca724dd5969f0c45a20b27f8b92fc8
```

目录内全部文件一起使用，禁止改写或混合 bundle。当前只有本机 ad-hoc 签名，没有可对外分发的已公证 DMG。旧试验 bundle 不要作为最终更新验收的目标。

受管 Lima 构建信息：

| 项目 | 固定值 |
| --- | --- |
| Lima | `2.2.1`，commit `27bc4c4b101e27994e01e36566a0f2091bbca507` |
| 源码 archive SHA-256 | `8b615cab44e93b404283456f060979d9b19d8066c1d05e0d4a1e6720822117aa` |
| 补丁 | `backend/tools/patches/lima-2.2.1-mutation-lease.patch` |
| 补丁 SHA-256 | `1eeb096360806932fc68bdd8283f4723e25811e01f2d355c1428396c7d6c909c` |
| 管理协议 | `amazme-mutation-startup/1` |
| Go | `1.27.1 darwin/arm64`，只用于构建 |
| limactl SHA-256 | `024de7c2741bb4d7c65c8ac8016f81d71d96e375a31e5f4782f32ba89eab48c6` |

本机 Go 在 `/Users/boom/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.1.darwin-arm64/bin/go`；源码 archive 在 `.artifacts/python-backend-p2/native-build/lima-source.tar.gz`。如需重建：

```bash
backend/.venv/bin/python backend/tools/build_managed_lima.py \
  --go /Users/boom/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.1.darwin-arm64/bin/go \
  --source-archive .artifacts/python-backend-p2/native-build/lima-source.tar.gz
```

构建 provenance 在 `backend/resources/lima/amazme-build.json`。`prepare_runtime.py` 会复用并校验补丁、协议和二进制摘要，不能用未打补丁的系统 limactl 覆盖。早期 Go 1.26 构建曾有 SSH 启动及 VZ 停止超时；已换成实测工具链，但没有证明超时唯一由 Go 版本造成。

## 下一轮按此顺序执行

1. 读取本文件、`backend/ARCHITECTURE.md`、定稿方案 P2 和真实当前代码；核对 `git status --short --branch`。本轮大量相关变更组成一个阶段实现，不要因为尚未提交就丢弃、stash 或重置。
2. 复跑源码检查。若源码有改动，构建新的不可变 A/B 目录，再运行矩阵；不要把旧 bundle 的结果算给新代码。
3. 先跑关键三项，再按 worker、supervisor、其他场景、update 分组排错。每次失败读该 report 的 traceback、case assertions 和 cleanup；修根因后重跑失败用例及受影响组。
4. 在同一最终代码的两个不同 `build_id` 上跑 `--case all`，取得 31 项全通过及 cleanup passed。失败后 runner 将后续场景标 not_run，不能把未跑项统计为通过。
5. 跑真实 Chrome 的 faux 客户端验收；完善失败路径和清理后重跑。P2 无需真实模型密钥；真实模型回归另行配置明确授权的私密文件，不能默认复用旧凭据。
6. 对照方案查漏：未知副作用、worker+监督器双崩溃、迟到停止、恢复预算、兄弟会话隔离、setsid/双重 fork 后代、VM 强停、审批/子工作/定时恢复，以及更新冻结/目标验证/完成中崩溃。检查运行证据是否覆盖契约，不能只按用例名称判断。
7. 再做一次全面代码审查，修复后补齐验证、更新证据与方案状态；通过后按明确文件路径原子提交，不推送。

在仓库根目录运行：

```bash
uv sync --project backend --frozen
uv build --project backend
backend/.venv/bin/ruff check backend
backend/.venv/bin/pyright --project backend/pyproject.toml
backend/.venv/bin/pytest backend/tests -q
backend/.venv/bin/python backend/tools/export_contracts.py
backend/.venv/bin/python backend/tools/verify_p2.py --list

# 每次输出自己的 bundle 路径；依次运行，分别记录为 A/B。
backend/.venv/bin/python backend/tools/package_backend.py
backend/.venv/bin/python backend/tools/package_backend.py

P2_A='/绝对路径/构建A/amazme-backend'
P2_B='/绝对路径/构建B/amazme-backend'
backend/.venv/bin/python backend/tools/verify_p2.py --executable "$P2_A" \
  --case 'host.lost_delivery,storage.commit_crash,events.ack_resync'
backend/.venv/bin/python backend/tools/verify_p2.py --executable "$P2_A" \
  --target-executable "$P2_B" --case all
backend/.venv/bin/python backend/tools/verify_client.py --executable "$P2_A"
npm run check:workspace
git diff --check
```

默认 `verify_p2.py` 仅跑 core；即使给出 target-executable，也必须显式 `--case all` 才是全矩阵。`--case 'worker.*'`、`'supervisor.*'`、`'update.*'` 可分组，`--case` 可重复或逗号分隔。运行器 PATH 只含系统目录，不依赖全局 Python/Node/Docker/Colima 运行产品。

## 尚未证明与已知限制

- 完整 31 项真实打包故障矩阵（本阶段已过 3 项）、双构建更新和真实浏览器尚待最终通过。部分运行器断言首次实际执行可能暴露 harness 或产品问题，不能降标准凑通过。
- 缺失参与者/错误验证回执、子工作取消目前主要是自动化回归；需按风险补充打包负例。SQLite FULL 和损坏副本有实际 SQLite 测试，但没有物理磁盘耗尽实验。
- worker 已退出且执行清理被阻塞时，Host 仍提供 health 诊断，但不会为了读取会话快照越过屏障新建业务 worker；独立只读会话诊断进程尚未实现。不要用放宽执行准入解决读诊断问题。
- SIGSTOP/SIGCONT、VM force-stop 不等于真实宿主睡眠/唤醒或断电。方案要求的物理睡眠/唤醒、空间不足和完整分发需单独取得证据。
- P3/P4 的 Electron/TUI 等既有客户端改造、PTY、多工作区、OAuth、插件和 Developer ID 签名公证仍未实施。

## 资源清理与证据保留

运行器只创建自己独占的 `/tmp/am2-*` HOME/profile/工作区，报告保留在那里。`.artifacts/python-backend-p2/` 保存源码检查、构建、原生实验和中间失败日志。它们是本地忽略文件，不随 Git 提交；迁到其他机器需单独复制需要的证据和资源，**不要复制 control.token、配对凭据或整个 profile**。

运行器正常退出或失败都会尝试 stop 和 destroy-vm，并核对租约真实释放。若人为杀死运行器，先读 report 里的准确 HOME/profile/bundle，再执行以下形式的命令：

```bash
HOME='/报告中的隔离HOME' '/报告中的bundle/amazme-backend' stop --profile '/报告中的profile'
HOME='/报告中的隔离HOME' '/报告中的bundle/amazme-backend' destroy-vm --profile '/报告中的profile'
```

不要按名称批量 pkill。必要的信号操作沿用 `verify_p2.py` 的 UID、命令路径、instance 和租约 inode 验证。开始前用户 Colima default 为 Stopped、Docker context 为 default，保留这些状态，不操作用户的 Chrome 调试会话。二进制、资源镜像、运行 profile 和临时产物不进 Git。

## 可直接交给下一位 agent

> 在 `/Users/boom/workspace/AmazMe` 的 `dev` 分支接续 Python 后端 P2。先读取 `docs/python-backend-p2-handoff.md`、定稿方案、当前代码和真实测试报告，保留已有阶段成果，不重做架构、不做旧数据兼容、不开始 P3。按交接顺序完成最终安装包的 31 项生命周期故障矩阵、双 build_id 更新和真实 Chrome faux 客户端验证；定位并修复所有失败，补齐缺失场景和清理证据。不要把单测或部分矩阵当作 P2 完成，不读取旧模型凭据。完成后全面审查、回归、更新证据，按仓库规则用明确路径执行原子提交，不推送、不发版。若阶段提交尚未产生，先核对并接续未提交变更，禁止清空或重置。
