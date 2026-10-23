# Python 后端可重跑验证

这是选型实验，不是正式后端，不接入旧产品、不读用户 profile、不调用真实供应商。
它验证 CPython/FastAPI/SQLite/PyInstaller 的组合、macOS 进程控制候选机制的实际边界，
以及 Linux VM 内容器执行域的清理机制。

需要 macOS 27、包含对应 SDK 的 Xcode、CPython 3.13 和 uv。依赖完整版本与下载摘要见 `uv.lock`。
从仓库根目录执行：

```bash
UV_PROJECT_ENVIRONMENT="$PWD/.artifacts/python-backend-proof/venv" \
  uv sync --project experiments/python-backend-proof --python /opt/homebrew/bin/python3.13 --frozen
.artifacts/python-backend-proof/venv/bin/ruff check --config experiments/python-backend-proof/pyproject.toml experiments/python-backend-proof
.artifacts/python-backend-proof/venv/bin/python experiments/python-backend-proof/run_proof.py
```

其他机器可替换 Python 的绝对路径。每次运行在 `.artifacts/python-backend-proof/run-*` 创建全新目录，
不覆盖前次证据。stdout 给出阶段和最终 `report.json`；错误时保存已完成结果并非零退出。
`--skip-package` 只做源码态验证，不能用它声称安装产物通过。

| 验证 | 实际操作 | 能证明什么 |
| --- | --- | --- |
| 独占 Host | 活进程持有 flock 时尝试启动第二个进程 | 同一测试 profile 不会产生两个 Host；强杀后 OS 释放锁 |
| HTTP/SQLite | 16 个并发同 ID 请求、内容冲突、严格输入、认证 | 单连接执行队列及事务去重；一份回执/出站事件 |
| 丢回执 | 提交事务后立即 `os._exit`，重启真实进程 | 数据已提交但响应丢失时可查询/重发，效果不重复接纳 |
| WS | 快照后、订阅前插入事件；断连后重新订阅 | 此测试场景下持久游标补发无缺口；不是慢客户端/完整预览协议证明 |
| 构建/代际 | 两份不同源码、相同 0.1.0；运行后改磁盘源码；发送旧 epoch 停止 | 控制边界拒绝不匹配身份，运行身份不会随磁盘标签改变；不是完整监督器接管证明 |
| 副作用窗口 | 调用意图前/后、文件副作用后、结果提交后强杀；再启动恢复及重试 | 真实 SQLite 与文件效果：尚未开始可执行；不明结果保持 unknown；已完成不重做 |
| 原生启动栅栏 | `POSIX_SPAWN_START_SUSPENDED`，放行前终止 | 已返回受管句柄的直属进程放行前不执行目标代码；不覆盖 spawn 返回前监督器死亡窗口 |
| 原生清理反例 | 目标 setsid、双重 fork，再 killpg | 进程组不能作为完整执行域；失败反例被观察到不代表完整清理通过 |
| Endpoint Security | 实际调用 `es_new_descendants_client`，不申请权限 | 当前本机普通实验签名返回 NOT_ENTITLED；不能推论所有授权安装均不可用 |
| onedir | 构建后移动到含空格路径、清开发 PATH，运行 API/WS/强杀场景 | 包内解释器、依赖和子进程模式能工作；不是完整 Electron/DMG 分发证明 |

原生 fixture 只写本轮目录，逃逸 fixture 有 2 秒自行退出期限。正常运行结束后停止本轮启动的服务；
不扫描/杀死用户进程，不修改系统权限或签名凭据。上面的 `run_proof.py` 不启动 VM。

Linux 执行域另用 Colima 0.10.3、Lima 与 Docker CLI 实测（需要联网下载公开镜像）：

```bash
.artifacts/python-backend-proof/venv/bin/python experiments/python-backend-proof/run_linux_proof.py
```

它在独立临时 COLIMA_HOME/LIMA_HOME 中创建随机 profile，使用 VZ/arm64、2 CPU、2 GiB 内存、
20 GiB 稀疏根盘与 10 GiB 稀疏数据盘，
禁用宿主目录挂载、SSH agent 转发、自动 context 切换和用户 SSH 配置生成。
容器禁用网络、全部 capabilities 和提权，使用只读根目录、128 MiB 内存、32 PID 上限；
仅实验 marker 卷可写。容器镜像固定 digest，实际摘要写入 JSON。
独立 Lima override 跳过本实验不使用的 rsync 默认安装，先断言镜像已含 Docker/containerd/runc/iptables；
不改用户的 Lima override，也不伪造工具或关闭容器安全控制。override 同样保存在本轮证据目录。
所有命令和阶段结果保存在独立 `.artifacts/python-backend-proof/linux-*`。

验证停止态 create 可重新发现、放行前终止零效果、控制进程 SIGKILL 后后代仍存活、
整个容器终止后 cgroup 空/删除及写入停止、其他会话继续、新 epoch 可执行、VM 重启不自动复活旧容器。
VM/容器/卷只属于本轮，finally 删除该 profile 和数据；既有 profile、容器和默认 context 不作修改。
若控制脚本本身被 SIGKILL，finally 无法运行；可按该轮 report.json 中的精确 profile 名称执行
`COLIMA_HOME=<本轮 colima_home> LIMA_HOME=<本轮 colima_home>/_lima colima delete --profile <本轮名称> --force --data`
清理，不能按前缀删除其他实例。
fixture 在 120 秒后自行退出，但这不等于 VM 清理。

Linux 脚本的成功状态为 `passed_runtime_mechanism_checks`，只表示这些真实机制场景通过。
工作区文件充当的许可仅为实验栅栏；生产实现必须使用私有认证控制通道。
这不是完整监督器、迟到放行竞争、网络/文件权限沙箱、工作区共享或 VM 断电故障的验证。
Colima 是实验工具，正式分发不要求用户安装它。

`report.json` 区分实验成功与架构通过：`completed_with_macos_execution_blocker` 表示实验已完成，
但“macOS 任意 shell 子孙进程完整清理”仍被阻塞。不能把脚本 exit 0 改写成整个方案通过。
全量脚本按当前机器没有 ES entitlement 的条件断言；换到具备该权限的环境，应另建 ES 功能实验，
不能仅修改预期返回值便宣称后代收容完成。

冻结程序只做本机 ad-hoc 签名检查，不是对外发布产物。Developer ID、hardened runtime、notarization、
Gatekeeper、Intel/原生 Linux 桌面分发、真实模型、完整监督器和双重崩溃恢复均未由本实验验证。
源码态 build_id 仅为实验源码摘要；正式实现还须覆盖依赖/helper/资源清单及不可变 bundle。
实验 API 有故障注入入口，只允许回环加随机本轮 token，不可移作生产 API。

正式实现应复用已验证的边界与故障场景，不直接部署这个实验程序。
