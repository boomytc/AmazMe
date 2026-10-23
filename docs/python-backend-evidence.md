# Python 后端选型运行证据

日期：2026-10-23。参考代码：`dev@42ff02ec6d2b49b7c6c139e1b3ef549af5b2e9f9`。
本轮新增隔离原型和方案证据，未接入正式产品、调整现有版本或提交发布。

## 1. 已确定的方向

Python 负责全部后端业务可行，采用 CPython 3.13、FastAPI/Uvicorn、SQLite 和 PyInstaller onedir。
首版必须提供通用 shell；用户已确认允许 Linux VM／容器。macOS 原生进程组无法满足后代清理要求，
因此通用 shell、PTY、第三方 MCP stdio 和任意代码执行进入受管 Linux VM 的容器域。
macOS 桌面驱动保留为单独审核的受控能力，不开放任意宿主 shell。

这确定了实施方向，不代表完整产品或 P1 已完成。正式契约和阶段见 [建设方案](python-backend-plan.md)。
选型脚本、锁定依赖和重跑方法见 [实验说明](../experiments/python-backend-proof/README.md)。

## 2. Python 与 macOS 实测

环境为 macOS 27.0.1 arm64、Xcode 27.1，CPython 3.13.16、SQLite 3.54.0、FastAPI 0.161.1、
Uvicorn 0.54.0、Pydantic 2.14.1、websockets 17.3、PyInstaller 6.22.3。
完整依赖及下载摘要固定在实验 `uv.lock`。这些是当前机器上跑过的组合，不是最低系统版本承诺。

最终原始摘要：[Python/macOS JSON](evidence/python-backend-2026-10-23.json)，
本机详细产物在 `.artifacts/python-backend-proof/run-1o7zyfeb/`；JSON 内包含源码摘要及各断言结果。
冻结程序约 38.6 MiB，仅包含本次最小实验，不能据此估算完整产品体积；阶段耗时也不是性能基准。

| 场景 | 运行方式 | 观察及结论 |
| --- | --- | --- |
| profile 独占 | 启动两个持有同一测试 profile 的真实进程 | 第二个在 OS flock 处失败；首个崩溃后可重启 |
| 并发接纳 | 同 ID/同内容发出 16 个并发请求 | 一个请求记录、一个 outbox；内容冲突返回 409，非法输入 422，认证失败 401 |
| 事务后丢回执 | COMMIT 后、HTTP 响应前 `os._exit(91)` | 重启后能查询原回执，同 ID 重发不重复接纳 |
| WS 窗口与重连 | 快照后订阅前提交，再断线重订阅 | 持久游标补齐窗口事件，重连得到同一事件；未覆盖完整预览和慢客户端协议 |
| 构建与代际 | 两份不同源码均标 0.1.0；修改已运行进程的磁盘源码；旧 epoch stop | build_id 不同；运行身份不随磁盘改写；错误构建/旧 epoch 控制返回 409，进程继续服务 |
| 外部文件副作用 | 意图前、意图后、效果后、结果提交后 SIGKILL；各做 3 次 | 分别得到重试后 1 次 done、0 次 unknown、1 次 unknown、1 次 done；SQLite 完整性检查通过 |
| 独立 onedir | 移动到含空格路径，PATH 仅 `/usr/bin:/bin` | 包内解释器运行 API、WS、构建检查及四个副作用窗口；只验证本机 ad-hoc 签名 |
| 原生启动栅栏 | 编译 C helper，`POSIX_SPAWN_START_SUSPENDED` 后放行/强杀；3 轮 | 已返回的直属句柄能阻止放行前执行；不覆盖 spawn 返回前监督器死亡 |
| 原生进程组反例 | 目标 setsid + 双重 fork，再 killpg；3 轮 | 后代仍持续写文件；fixture 有自行退出期限并在结束后停止写入 |
| ES 后代接口 | 实际调用 `es_new_descendants_client`；3 轮 | 返回 3，即 NOT_ENTITLED；未申请受限 entitlement，不能假定发行环境天然可用 |

上述副作用测试验证保守恢复策略，不宣称任意外部服务 exactly-once。控制接口实验也没有实现完整
Host/worker/监督器接管，不能以 409 断言替代跨进程生命周期验收。

Apple 的后代追踪接口确实存在，但要求对应权限；本机失败只说明当前签名条件不具备它。
来源：[Apple 接口文档](https://developer.apple.com/documentation/endpointsecurity/es_new_descendants_client%28_%3A_%3A%29)、
[Endpoint Security 权限入口](https://developer.apple.com/system-extensions/)，并已核对本机 SDK 的 `ESClient.h`。

## 3. Linux 执行域实测

**执行隔离机制通过本轮实测。** 原始摘要见 [Linux JSON](evidence/python-backend-linux-2026-10-23.json)，
VM 配置与基础镜像摘要见 [环境 JSON](evidence/python-backend-vm-environment-2026-10-23.json)。
本机完整命令日志在 `.artifacts/python-backend-proof/linux-u7ewbay5/`，本轮五组场景各执行一次。

实际组合为 Colima 0.10.3、Lima 2.2.1、VZ/arm64、Ubuntu 24.04.4、Linux 6.8.0-117、
Docker Engine 29.5.2、cgroup v2。Python fixture 镜像固定为
`python@sha256:bf12ecc0bea3f171d55145dd02c78b5eeb09f30ee2ac9cc2b4c9e4e8f5e30741`。
VM 无宿主目录挂载，容器无网络、无 capabilities、禁止提权、只读根目录，只有本轮 marker 卷可写。

| 场景 | 实际观察 | 证明范围 |
| --- | --- | --- |
| create 后未登记 | 停止态对象可按标签重新发现，marker 为空，可删除 | 丢 create 回执的资源发现机制；没有实现正式持久监督器 |
| start 后未放行 | 受信任 init 已在容器内运行；终止后容器退出、cgroup 删除、零 marker | 启动与用户代码放行可分开；文件许可仅是实验夹具 |
| 控制进程 SIGKILL | 普通子进程与 setsid/双重 fork 后代继续写入 | 控制进程死亡不能充当执行已停止的证明 |
| 清理后再执行 | 整个容器退出码 137、PID 归零、原 cgroup 删除；两份 marker 均固定在 847 字节；其他会话继续，新容器可写，旧 marker 不变 | 在该隔离配置下，脱离进程组的后代仍属于可整体终止的执行域；清理屏障机制可用 |
| VM 有序停止/重启 | guest boot_id 改变，restart=no 的旧容器保持退出，marker 不再变化 | 旧执行不会自动复活；没有模拟宿主断电、磁盘损坏或运行时本身双重崩溃 |

清理断言不是只等 0.3 秒看文件没变：同时核对真实容器停止及 guest cgroup 消失。`setsid` 反例在
macOS 进程组中存活，在此 Linux 执行域内可整体终止，是本轮最直接的架构选择依据。

两次前置失败也保留在本机独立目录：第一轮向只读容器复制脚本被拒绝，随后改为启动参数传入；
第二轮 Lima 自动安装本实验不用的 rsync，软件源索引下载超过 600 秒。最终使用独立
COLIMA_HOME/LIMA_HOME 的 override 跳过默认安装，先检查实际需要的运行时命令存在；
未关闭签名、容器能力限制、文件只读或任何清理断言。此调整只改变实验初始化，不证明完整安装产品已可离线启动。

实验结束已删除临时 VM、容器、卷和其配置目录；既有 default profile 仍为 Stopped，Docker context
仍为 default，未留本轮运行进程。公开镜像下载缓存保留，便于后续重跑。

机制依据：Linux PID namespace 的 init 退出时，内核终止其余 namespace 进程；cgroup v2 提供
递归进程域及 populated 状态。容器不能拥有迁出受管域的能力，且只有监督器能操作其运行时。
来源：[Linux PID namespace 手册](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)、
[Linux cgroup v2 文档](https://docs.kernel.org/admin-guide/cgroup-v2.html)。

VM 采用现成管理组件的选择与其公开能力一致，实际发行集成仍待实现。
来源：[Lima VZ 配置](https://lima-vm.io/docs/config/vmtype/)、
[Lima 2.2.1 依赖安装配置](https://github.com/lima-vm/lima/blob/v2.2.1/templates/default.yaml)。

## 4. 实施前后边界

可以据此开始正式 P0/P1，以下仍是实现验收项，不能标作通过：

1. 正式监督器持久登记、认证放行、epoch 封闭与在途创建收敛；Host/worker/监督器双重崩溃及迟到消息。
2. 一个真实供应商、实际客户端、完整流式预览、取消与审批，以及模型调用到容器工具结果的闭环。
3. 宿主工作区映射、符号链接和权限、网络策略、真实 PTY、MCP、桌面驱动/TCC、远端失联。
4. VM 管理器与镜像随产品分发、干净环境离线启动、Developer ID/hardened runtime、公证与更新。
5. Intel/原生 Linux 宿主、系统睡眠唤醒、断电/磁盘损坏，以及合计内存/启动性能预算。

通用 shell 的运行环境是 Linux；它不能运行 macOS 的 `xcodebuild`、AppleScript 或直接访问钥匙串。
这项取舍已写入方案。宿主原生能力需要独立受控入口及退出证明，不能用未受管 shell 绕开清理门槛。

本轮验证不用真实账号、历史 profile 或真实工作区副作用。产物只保留在忽略目录中，稳定 JSON 摘要
随本文归档；每次运行目录互不覆盖。原型故障注入 API 不能作为生产服务部署。
