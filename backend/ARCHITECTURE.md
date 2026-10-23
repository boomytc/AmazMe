# P0/P1 实现边界

用户先以 `amazme-backend init --profile … --workspace … --provider-config …` 创建空白配置，
再 `amazme-backend serve --profile …` 打开 Web 客户端。创建会话后提交请求，查看流式文本、
工具命令与结果，可取消并在重启后继续。VM shell 只访问 init 时明确授予的目录。

采用 HTTP over UDS 候选 A：Host 与 worker 各有自己的 API，执行监督器仅负责资源，
不转送业务请求。Pydantic 模型是边界真源，连接和数据库事务由拥有者封装。
借用候选 B 的深接口：worker 只请求 `open/run/close`，不自己协调 create/register/permit。
JSON RPC 单中心方案增加路由、帧解析与队列调度，不作为首版实现。
两份候选及独立评审保留于 `.artifacts/python-backend-p1/design-{a,b,review}.md`。

| 模块 | 所有权与公共入口 |
| --- | --- |
| contracts | API、身份、会话、工具、清理回执的严格模型及 schema |
| storage | 专属线程 SQLite；接纳、状态及 outbox 同事务 |
| supervisor | 独立监督器；host fencing、worker 句柄、执行代际、容器台账、清理回执 |
| vm | 固定包内 Lima/VZ/Docker 和镜像；执行资源的系统适配入口 |
| worker | 每会话 worker，独占会话写锁；模型循环、工具意图、恢复与取消 |
| providers | OpenAI SDK 后的 DeepSeek 适配；faux 仅用于确定性测试 |
| host | profile 锁、Host 元数据、认证/Origin、会话代理、REST/WS、静态 Web |

监督器串行化每会话的准入和资源变更，但不在执行等待时持有控制锁。
worker 分配、Host 接管与停止由同一控制锁串行化，启动中句柄也占有槽位；
停止和失联先撤销 worker 身份，迟到调用不能再次开启执行。Host 的缓存连接按会话串行建立并验证实例身份。
取消先封闭代际，再等待在途创建/放行收敛和整个容器退出；未确认时保持 blocked。
worker 的生命周期任务持有租约，取消只中断其内部模型/工具任务；取得租约和关闭租约不被重复取消打断。
取得租约的回复丢失也保持 blocked。工具执行任务独立于 HTTP 等待者，完成回调负责回收容量。
Host 退出只发送带 host_epoch 的控制消息，不凭缓存 PID 杀已接管的进程。
容器 init 通过运行时私有 stdin 收到许可后才启动 shell；用户命令降为普通 UID。
每个工具 scope 使用独立容器，统一归属 execution_epoch，代际清理汇总全部 scope。
显式停止等待服务锁释放；删除 VM 必须同时持有 Host、监督器和会话写锁，运行中不可绕过生命周期入口删除。

P0/P1 先提供一个明确授权工作区、Web 客户端、DeepSeek 非推理流与 read/write/shell 工具。
完整多工作区、PTY、审批交互、插件、账号 OAuth 和全更新矩阵按定稿后续阶段扩展。
认证、取消、写锁、构建身份、进程清理与离线包内执行资源属于本阶段，不能延期。
