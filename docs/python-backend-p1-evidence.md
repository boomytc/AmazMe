# Python 后端 P0/P1 实施与验收

日期：2026-10-23。新后端版本 `0.1.0`，实现位于 `backend/`。本轮完成首个独立 Web 客户端、
DeepSeek Flash 与 VM shell/read_file/write_file 的闭环，不加载旧 TS 内核、不迁移旧历史数据。

## 实现范围

| 项目 | 实现与验证方式 |
| --- | --- |
| 工程与契约 | uv 锁定依赖、Ruff、Pyright strict、wheel/sdist；Pydantic 生成事件 JSON Schema/TS，公开 OpenAPI 从实际 Host 导出 |
| 进程所有权 | 每 profile 单 Host、按需会话 worker、独立监督器；OS flock、私有认证 UDS、Host epoch、实际 build_id |
| 持久化 | 会话独占 SQLite 连接线程；请求、去重、状态及 outbox 同事务；原 ID 查询与重发；未知效果不自动重做 |
| 模型与工具 | OpenAI Python SDK 后的 DeepSeek 非推理流；工具意图与结果持久化；受管 Linux 容器执行通用 shell 与文件工具 |
| 清理屏障 | 创建意图先落盘；停止态容器登记；受信任 PID 1 等待私有许可；封闭 epoch 后终止容器并核验 cgroup，再开放新执行 |
| Web | 本机配对、HttpOnly cookie、Host/Origin 校验、会话创建、流式事件校验、取消、快照恢复、继续对话 |
| 独立产物 | 包内 Python、Lima/VZ、Docker CLI、固定 Linux 和离线工具镜像；移动到含空格目录，清开发 PATH 后运行 |

Web 中的“可执行”只表示会话准入状态；取消首先接纳请求，在退出证明完成前保留“正在清理”。
VM 控制失联时会话 blocked，新提交返回 503。已完成的文件写入不会因为取消而回滚。

## 最终构建与证据

最终候选 build_id：`605e4f7a091f0d5ba9cd888ca3f9bf7a0ef88585864e9db580be8cf8cabf3753`。
包内 126 个校验文件，目录约 445.6 MiB。此体积包含完整 VM/工具镜像，不是此前最小 Python 原型的体积。
构建目录：`.artifacts/python-backend-p1/package-6jvwybiv/AmazMe Python 0.1.0/`。

同一最终构建的报告均为 `passed`：

- [运行与恢复 JSON](evidence/python-backend-p1-runtime-2026-10-23.json)：`.artifacts/python-backend-p1/runtime-qcihhisq/`。
- [客户端故障 JSON](evidence/python-backend-p1-client-2026-10-23.json)：`.artifacts/python-backend-p1/client-oh10223t/`。
- [真实 Web/模型 JSON](evidence/python-backend-p1-web-2026-10-23.json)：`.artifacts/python-backend-p1/browser-5qtoylhv/`。
- [构建与源码摘要](evidence/python-backend-p1-build-2026-10-23.json)：锁定实际文件、源码、版本和验证入口。
- [Web 运行截图](evidence/python-backend-p1-web-2026-10-23.png)：实际页面，非设计图。

Ruff、Pyright strict、`uv build` 和 19 项本地回归检查通过。实际安装包的生命周期验证、真实浏览器与
真实模型验证另外运行，不能用这 19 项检查替代。每份运行报告包含实际构建身份、会话/容器身份和结果；
失败尝试保留在独立本机目录，不覆盖成成功。

核心验收采用真实进程、HTTP/WS、SQLite、VM 和文件写入：

1. 16 个并发同 ID 请求只写一个字符；同 ID 不同内容 409；停止重启后重发仍只有一次效果。
2. 未认证 401、外部 Origin 403、超限 body 413、重复 Host 被 OS 锁拒绝；私有 socket 必须为 0600。
3. setsid/双重 fork 工具持续写入时取消，返回 202 后保持清理状态；容器停止并核验后停止写入，随后新工具可执行；清理期间追加 24 次取消也不破坏屏障。
4. 强杀真实 worker，监督器清理旧域；16 路并发查询获得一致的恢复回执，替代 worker 恢复为 unknown，不重放旧工具，随后接纳新任务。
5. 强杀 Host，同构建新 Host 接管存活 worker，文件效果仍一次；旧 epoch 停止和错误 build_id 均返回 409。
6. 临时移走本轮 Docker 控制 socket，并等待旧连接过期：旧工具仍写入，取消保持 cancelling，新提交返回 503；
   恢复控制通道并正常停机/重启后可继续，不能以超时或信号发送成功冒充清理完成。
7. 用独立 Chrome profile 实际操作安装包 Web：DeepSeek 调用 shell 写/读 `real-proof.txt`；页面刷新恢复；
   第二轮调用 write_file/read_file 处理中文文件。检查真实文件、供应商 response ID、工具退出码、WS 预览和截图。

8. 运行中执行 destroy-vm 被锁拒绝；故意占用 HTTP 端口使启动失败，已启动的监督器/VM 被关闭，随后正常启动并执行成功。
9. 文件工具传入 32,000 字符（含四字节字符、引号及换行），VM 内实际写入 64,001 字节，与原始内容完全一致。
   本地回归另覆盖 32,000 个四字节字符加最长路径的传输容量。
10. 真实 Chrome 中让请求先提交再丢失回复，刷新后沿用同一 ID 重发，文件效果仍一次；
    断网期间主动关闭 WS，持续重连后恢复快照与工具记录；迟到响应不清除另一个会话草稿；422 后可以改正并重新发送。
11. 实际切断 VM 控制通道后取消，页面在不刷新的情况下显示“等待清理”和原请求的清理错误。

## 提交前完整复审

本轮重新追踪了 HTTP/WS、SQLite、模型循环、执行域、进程所有权、客户端状态和安装入口，修复以下遗漏：

| 问题 | 结构性修复与证据 |
| --- | --- |
| 重复取消打断租约清理，或在启动前取消造成状态悬挂 | 生命周期任务独占取得/关闭租约，仅取消内部工作任务；回归覆盖 open 回复暂停、连续取消和 claim 后取消，实跑 24 次取消 |
| 同会话并发 ensure 在启动未登记完成时重复分配 | 控制锁覆盖查询、清理、容量、登记与 spawn；启动中句柄可重附着；16 路回归与强杀后的并发恢复 |
| 失联/停止的 worker 仍可能发起新准入 | 先撤销身份再清理，接管与停止串行；旧 Host 代际与不同构建继续被拒绝 |
| HTTP 等待者取消后执行槽位未回收 | 执行任务完成回调回收并取走异常；回归连续断开 18 个等待者，超过 16 槽仍可运行 |
| 文件内容上限与命令/私有 stdin 上限冲突 | 内部命令独立容量、UTF-8/base64 编码；边界回归及 VM 大内容逐字验证 |
| 无工具回执时误标 failed，未知存储格式预检先改了 journal | 未决工具标 unknown、不重排；格式检查先只读打开；SQLite 实测检查原文件字节与无新增 journal |
| 已接纳但丢回复后刷新会换 ID；迟到响应清掉其他会话输入；拒绝后不能修正 | 浏览器保存待确认请求 ID，绑定会话与提交文本，确定性拒绝释放待确认状态；真实 Chrome 故障验证 |
| 长回复挤掉工具快照，队列挤掉当前执行项，清理失败未推送页面 | 快照独立取工具历史及完整游标，保留活动请求；清理状态写入 outbox；局部回归和真实页面验证 |
| 删除 VM 没有运行中互斥，初始化失败与停止存在资源窗口 | 删除取得所有服务写锁，初始化在 finally 内回收，停止等待监督器锁释放；独立包故障实跑 |

修复主要落在代码所有权、模块边界和状态不变量（第 1 层），第 2 层用回归与故障运行器验证跨进程时序。
外部进程退出、浏览器断网及真实副作用不能仅靠类型保证，因此保留实际运行验证；没有以新增文字规则代替修复。

## 首轮实施中修复的问题

- 直接使用 Lima 时，补齐 guest Docker socket 权限和基础镜像 DNS；不再依赖 Colima 运行时组装。
- Docker 离线 save/load 不保留仓库 digest 别名，改为按固定镜像内容 ID 创建容器，并在导入后核验。
- DeepSeek 拒绝历史 assistant 消息中的空 `tool_calls`；适配层只在真实工具调用时发送该字段，增加回归检查并实跑连续两轮。
- Uvicorn 自行创建 UDS 的默认权限不符合私有控制要求；由后端预先绑定 0600 socket 再交给服务器，加入运行与回归检查。

这些问题分别在资源适配、供应商边界和 socket 创建入口修正，并由自动化检查覆盖。

## 证据范围与后续阶段

本阶段是定稿方案中“一个客户端、一个模型、基础文件/shell、取消/重启、独立本机包”的垂直闭环。
不是全产品重构完成，也不是全部故障组合已验证。以下继续按 P2–P4 处理：

- Host/worker/监督器同时崩溃、每个 create/register/permit 丢回复窗口的完整故障矩阵、VM 断电/磁盘损坏、更新冻结与异构建替换闭环。
- 完整审批、后台/子任务、上下文压缩、历史分页、全部客户端/供应商、插件、PTY、SSH 和受控 macOS 桌面驱动。
- 更完整的工具镜像和网络授权策略、多工作区、睡眠唤醒、Intel/原生 Linux、性能与容量调优。
- Developer ID/hardened runtime、DMG、公证、Gatekeeper 与对外更新。当前仅本机 ad-hoc 验证，无标签或 Release。

P1 的显式容量和执行限制见 [后端使用说明](../backend/README.md)。本轮真实模型使用获准复用的
DeepSeek 配置副本，仅作用于隔离测试工作区；验收结束删除秘密副本，原配置和凭据不改动。

本轮测试 profile 中的模型 API key 已清空，临时 provider 配置已删除，源码/报告扫描未包含该秘密。
测试服务、浏览器和 VM 已退出；用户原有 Colima profile 和 Docker context 保持原状。

重跑入口：`backend/tools/verify_runtime.py`、`backend/tools/verify_client.py`、`backend/tools/verify_web.py`；构建入口：
`backend/tools/package_backend.py`。完整操作命令、配对和停止方式见后端 README。
