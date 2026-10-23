# Python 后端 P2 交接

日期：2026-10-23。分支 `dev`。本文件记录故障矩阵和浏览器验收之后的状态。P2 的协议故障注入已经在两份不同 `build_id` 的安装目录上通过。物理磁盘、真实睡眠/断电和签名分发没有证据，所以不能把 P2 标成全部完成。这些缺项不阻塞后续 P3 的产品与客户端实现。总表见 [重构验收台账](python-backend-completion.md)。

## 已通过

源码检查：Ruff、Pyright 0 错误、pytest 285。最终矩阵使用同一源码状态打出的两份 ad-hoc onedir：

| | 目录 | build_id |
| --- | --- | --- |
| A | `.artifacts/python-backend-p2/package-gbn32ffr/AmazMe Python 0.1.0` | `257b71973f69ed8fe2178ab41acddbb973360e44db507dc7c7ba7a1af6ddac5c` |
| B | `.artifacts/python-backend-p2/package-r3e13r24/AmazMe Python 0.1.0` | `7f4e9d802bbe1be8a96748bfdd89bf677bf09811e44398a12b6c8bbbd143b2fb` |

`verify_p2.py --case all` 的 34 项全部 `passed`，没有 `skipped` 或 `not_run`。共享 profile 和审批 profile 的 stop、destroy-vm、进程租约退出都通过。本地报告是 `/tmp/am2-uphi4eyo/report.json`，不进 Git。

Chrome 155 headless 跑 `verify_client.py --executable` 构建 A，6 项 faux 客户端检查通过，页面无错误，浏览器、服务和 VM 已关闭。

相对阶段交接新增的真实运行覆盖：

- `children.cancel_descendants`：取消正在写盘的 setsid/双重 fork 子 shell。取消回执不是终态，清理证明早于终态，后代停止，未知写入要核对后才能再写。
- `update.roster`：缺一个已停止参与者、改写历史 `build_id`、验证回执里塞入容器，三次都拒绝激活。恢复原记录后，同版本的另一个 `build_id` 才完成更新。
- `bundle.replaced_file`：克隆安装目录并改一个样式文件，启动在 ready 前拒绝。原安装目录不改。

`supervisor.*` 同时杀掉暂停点上的 worker 和监督器。`worker.*` 只杀 worker。

## 本轮产品修复

1. 会话的 worker 已经退役，健康列表里只剩 `worker_restart_budget_exhausted:<session>` 时，只读快照返回这个代码，不创建新 worker。以前一律返回 `diagnostic_worker_unavailable`，预算耗尽到不了调用方。回归在修复前失败。
2. 监督器关闭先标记停止并做 VM 清理，然后放开控制锁，再等 worker 退出。启动中的 worker 需要这把锁才能结束初始化；握着锁等待会让 `stop` 一直占着监督器锁。审批 profile 上可以稳定复现，修复后 `approval.wait` 的 stop 通过。

运行器在监督器仍阻断时，把拒绝新建 worker 当作准入结果，再显式恢复。更新激活会等 worker 离开 `starting` 再核对指纹，避免把同构建的启动中 worker 看成另一个构建。

## 仍未验收

- 物理磁盘耗尽。SQLite FULL 和损坏副本不等于磁盘写满。
- 真实睡眠、唤醒、断电。SIGSTOP/SIGCONT 和 VM force-stop 是模拟。
- Developer ID 签名、公证和 staple 后的分发 DMG。上面的目录是本机 ad-hoc 构建。
- Electron、TUI、PTY、多工作区、OAuth、插件和真实模型花费。这些不属于本轮。

可提交的脱敏摘要：`docs/python-backend-p2-phase-evidence.json`。
