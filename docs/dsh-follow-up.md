# DSH 能力吸收记录

本轮参照终点固定为 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。所有上游源码均用 `git show <固定 SHA>:<路径>` 阅读；没有 vendor、合并上游或引入 Cordis。

## 基线与来源

- AmazMe：`dev`，起点 `629beee532ca379a837c6d66cb40a74f9e40497b`，跟踪 `origin/dev`，领先 1。origin 为 `https://github.com/boomytc/AmazMe.git`。工作区、暂存区及未跟踪文件均为空；后端模块化重构已经在起点提交内。
- DSH：`master`，起点 `687f282e8625c6b8d11ff58211a90524be2e4317`，跟踪 `upstream/master`；origin 为 `https://github.com/boomytc/deepseek-harness.git`，upstream 为官方 `https://github.com/deepseek-ai/deepseek-harness.git`。工作区、暂存区及未跟踪文件均为空。
- 执行 `git fetch --no-tags upstream` 后固定上述终点。merge-base 等于起点，左右计数 `0 / 1539`。只读取该范围的分组 log、diff、show，不提前移动本地 master。
- 阅读 `docs/tool-catalog.md`、`docs/architecture.md`、`docs/subsystems/tools.md`，再按输出、文件、作业、时间与排除项分组进入实现。
- Python 定向基线：`test_native_execution.py test_execution_p2.py test_workspace_files.py test_artifacts.py test_run_options.py` 共 85 项通过。结构检查、导入闭包、AI 边界探针及契约生成检查通过；AI 探针使用进程内 HTTP 替身，没有真实供应商调用。
- Web 基线：先 `npm run build --workspace @amazme/web`，再包测试，24 文件 / 228 项通过。
- 开始资源普查：245.9 GiB 可用、无脚本 scope 内的泄漏、`build_allowed=true`。

## 候选取舍

| 领域 / DSH 来源 | 实际行为与新旧区分 | AmazMe 所有者、决定与验收 |
| --- | --- | --- |
| 输出：固定终点 `packages/subprocess/subprocess-local/src/output.ts`、`packages/util/output-retention/src/index.ts`、`packages/shell/tool-bash/src/render.ts` | 源流保存与有界呈现分离；保存失败不能继续宣传完整 spill。这是 DSH 起点已有能力，非本轮领先提交新增 | 采用行为，由 `execution/native.py`、`execution/output.py` 与现有 scopes 拥有。原实现采集时只留每流 65536 字节。用真实命令、分段回读、中文和存储失败验证 |
| 文件：固定终点 `packages/fs/tool-fs/src/{read,edit}.ts`、`packages/fs/fs-observation-policy/src/index.ts`、`packages/fs/fs-local/src/fsio.ts` | 分段读、唯一字面量替换、以实际观察版本做 CAS；区分未观察/不存在/存在。这些源码在起点与终点间无变化，属于补足既有能力 | 采用；复用 `workspaces/files.py`、Host 文件准备和持久会话。人工文件 API 保留显式 expected_digest 契约。契约与证据见文件单元 |
| 作业：`70eab5706e`、`ed645016cd`、`7854778639`，以及固定终点 `packages/jobs/{jobs-local,tool-jobs}`、`packages/shell/tool-bash` | 领先提交增加完成通知、避免通知无端消费日志游标、用户插话结束 job_output 等待；后台注册本身在起点已存在 | 采用；复用唯一 Supervisor、execution SQLite、持久投递。不会移植 DSH 内存 registry，也不会把前台执行超时改成自动无限后台。契约与真实长命令证据见作业单元 |
| 时间：`22f8be30a1`、`2f30c684ac`、`1696816d2c`，固定终点 `packages/context/time-context/src/{index,request-zone}.ts` | 时间按请求装配，恢复浏览器时区先等待真实投影；领先范围包含恢复修复 | 采用产品语义，由 Python 请求装配拥有；客户端只报告时区。契约与受控时钟证据见时间单元 |
| guard：固定终点 `packages/guard/timeout-policy/src/index.ts` | 超时传播取消并等待实际结算，不放弃未终结的 promise；该核心源码非领先范围新增 | 保留 AmazMe 原有真实退出核对及 unknown/cleanup 屏障；作业单元验证，不另加循环 |

本轮不引入计划模式、ask_user、todo、自动标题、重复调用提醒、跨会话检索、goal、LSP、browser-use、worktree、ACP 或新的 OS 沙箱。现有审批、会话、工作流、工作区、计算机操作与排程路径保留各自职责；这些路径的存在不等于覆盖 DSH 同名功能。新交互与扩展需要独立需求和验收，均延期，不借本轮改写产品。DSH 的 TS 插件运行时、市场、Agent Teams、遥测扩展和第二套 run_code 不适用当前 Python 执行所有权。

延期项也读取了固定终点的实现入口。下表 SHA 是该入口在固定终点前的最近变更；“领先触及”只说明本次范围修改过该入口，不把重构提交解释为能力首次出现。

| 候选 / 固定终点源码与 SHA | 读取到的行为 / 范围归类 | 决定、当前对应与后续边界 |
| --- | --- | --- |
| `plan/plan-mode/src/index.ts`，`47b6867566` | 记录 plan/mode，在已接受的 step 边界切换，并由用户问题能力审阅退出；领先触及取消结算 | 延期模式本身。AmazMe 的审批是工具副作用准入；新增模式需单独定义会话状态、恢复与 UI 验收 |
| `interaction/tool-ask-user/src/index.ts`，`b6401085cb` | 默认阻塞问答，显式 timed 可返回 pending 并保留答题机会；此入口在起点已有且无本轮差异 | 延期。已有审批不等于通用问答，需补问题身份、迟到回答和恢复契约 |
| `todo/tool-todo/src/index.ts`，`92f9e79fac` | 每次写入整份 todo/write；并行 in_progress 策略显式配置；领先触及投影 | 延期。工作流子任务不等于模型 todo；应由 sessions 持久化、客户端呈现 |
| `session/session-title-first-prompt-llm/src/index.ts`，`353fe00d63` | 从第一条人工消息调用单独模型生成受限标题；起点已有，此入口无差异 | 延期。当前手动会话标题可用；另需模型费用、失败回退与用户改名竞争策略 |
| `guard/repeat-tool-reminder/src/index.ts`，`fb79a944f5` | 比较完整规范化参数，在配置次数注入有界提醒，不否决或改写调用；起点已有，无差异 | 延期提醒。当前稳定调用身份和 unknown 屏障解决重复副作用，不能据此宣称已有重复思考提醒 |
| `experimental/tool-session-query/src/{index,operations}.ts`，`c3efd4bff8` | 先核对调用者工作区，再搜索/读取授权会话事件与关系；领先触及投影 | 延期模型跨会话检索。现有客户端搜索不等于模型检索授权；需独立索引、范围与隐私验收 |
| `goal/tool-goal/src/{index,authority}.ts`，`c3efd4bff8` | 要求确切活动 agent、开放 turn 与人工或指定 goal-round 权限；领先触及投影 | 延期产品 goal。现有持久调度保留；本轮作业通知仅做有界续办，不新增 goal 循环 |
| `lsp/tool-lsp/src/index.ts`，`79bd3d8da7` | 通过 ctx.lsp 做只读定义/引用/实现/hover，转换 UTF-16 坐标并限制结果；起点已有，无差异 | 延期。当前文件/命令能力不等于 LSP；需单独语言服务进程所有权与退出验证 |
| `browser-use/browser-use/src/index.ts`，`e1612c2fdc` | 独占 provider 槽位，释放前保留资源关闭所有权；起点已有，无差异 | 延期新浏览器后端。当前 computer 功能不等于浏览器能力，需单独 profile、导航和断开恢复验证 |
| `experimental/tool-worktree/src/index.ts`，`c67a2d6fdf` | 从本地 ref 创建分支与 checkout，并切换会话目录；离开后保留；起点已有，无差异 | 延期模型 worktree 工具。当前 workspace grant 不等于 Git 生命周期；需创建、路径切换与保留策略验收 |
| `acp/acp/src/index.ts`，`b096659245` | JSON-RPC stdio 桥接持久会话、取消、权限与语义更新；领先触及分支隔离 | 延期 ACP。现有 RPC/SDK 是自身协议，需另行核对 ACP 兼容和权限，不作为第二个业务循环 |
| `sandbox/sandbox-local/src/index.ts`，`64ece4cac1` | 探测 bwrap/Landlock、Seatbelt 或 Windows ACL runner，约束不可用时拒绝；领先触及写授权安全 | 延期 OS 沙箱。当前 shell 明确使用本机用户权限，不宣传隔离；引入需要逐平台真实验证 |

## 输出单元契约

- 采集原始 stdout/stderr 时先写各自日志，再制作内联预览。预览仍每流最多 64 KiB；有效 UTF-8 不因预览切点产生替换字符。无效 UTF-8 以 replacement 字符显示。
- `ToolResult.output` 给出稳定调用 locator、各流 observed/retained 字节数、错误及秒级过期时间。范围是各流从 0 开始的前缀，不承诺 stdout/stderr 的交错顺序。
- 模型 `tool_output` 使用独立的流和零起始字节 offset，最多读取 32000 字节；使用返回的 next_offset 继续。有效字符不拆页；活动流最后的半个字符暂不前进。任意落在续字节的游标拒绝。读取无消费游标，重复读取不改变结果。
- 每流上限 4 MiB，每 profile 最多 128 份已预留日志，载荷上限 1 GiB，另有有界元数据。预留在现有 scopes 中，与启动意图同事务保存。配额用尽不阻止命令执行，但明确返回 `output_capacity`；超过流上限返回 `output_quota`，后续仍统计观察字节。
- 保留期为启动起七天；新 shell 准入时删除已过期且真实清理完成的日志及本单元元数据，保留执行审计记录。不为腾容量提前删除未过期日志，也不删除未能确认清理的资源。
- 写入失败为 `output_save_failed`；元数据失败为 `output_metadata_failed`，停止后续保存尝试，不假称完整。runner 未能结算时日志的 settled 保持 false。
- locator 经执行库解析，拒绝其他会话及不同工作区根；不接受模型提供的磁盘日志路径。复用现有受限进程环境，不额外记录环境、凭据或控制令牌。
- artifacts 当前单件 1 MiB、每会话 32 件、完整 base64 读写，无流式追加/分页/过期配额。因此不把它扩成日志库。

## 审查和验证记录

输出单元的 changed 范围是新增输出契约、采集/回读、工具装配、scopes 迁移与相应生成产物及测试。新增功能独立标作 feat，不将行为变化称作精简。

- simplify-code：检查新增分支、调用者和失败路径；原始采集和预览共享 collect，UTF-8 解码共享 decode_prefix。未做范围外重构。
- simplify-test：保留既有进程输出边界测试并扩展回读断言；新增测试保护两流/字节游标、活动半字符、配额、真实 ENOSPC 写入错误、过期/符号链接、持久会话归属及真实 Host 断开重连。没有删除、跳过或弱化既有断言，没有新增测试专用生产接口。
- 首次真实 Host 验证与 Web 构建并发，构建产物改变造成 supervisor_identity_mismatch；此结果不证明日志失败。停止并核对该测试唯一残留 Supervisor 后，串行重跑真实 Host 测试通过。后续构建与生命周期验证串行。
- 最终定向测试：`test_output_retention.py test_native_output.py test_native_execution.py test_execution_p2.py test_run_options.py test_session_model.py` 共 89 项通过。Web 先构建再测试，24 文件 / 228 项通过。Pyright 0 错误；Ruff、架构检查（222 模块 / 5294 边 / 0 违规）、导入闭包、AI HTTP 替身探针与生成契约检查均通过。
- 独立重读沿“输入 → scopes 意图 → runner 原始采集 → 有界预览 → 会话工具结果 → 新客户端 / 新 worker 回读 → 过期清理”核对。修正了工作区根归属校验、元数据失败反复落盘，以及两个流分别判断 UTF-8 预览结尾的问题。两个 changed gate 均通过；9 个新增或扩展测试声明全部保留（R=9，F/C/D=0），无删除。
- 结束资源普查返回 0，`reclaimed=true`、`build_allowed=true`，只覆盖脚本声明的进程归属、VM/临时目录、package 保留数与磁盘 scope；不据此宣称系统没有其他资源。

## 文件单元契约与证据

- 模型 `read_file` 支持零起始字节 offset 和最多 32000 字节的页，返回 JSON 范围、next_offset、whole-file SHA-256、total_bytes 与 has_more。有效 UTF-8 不拆字符；模型文件上限 16 MiB。全文件流式验证 UTF-8 并计算摘要，检查读取期间的文件身份/时间戳变化；不把不同版本的窗口拼成一个摘要。
- `edit_file` 是字面量替换，默认唯一匹配，replace_all 才允许多处替换。保留原始换行，不自动转换 CRLF。零匹配为 file_edit_not_found，多匹配为 file_edit_ambiguous；非文本为 file_not_text，越界页为 file_cursor，过大为 file_too_large，陈旧版本为 file_conflict。修改上限沿用现有 1 MiB 文件/备份边界。
- FileObservation 是 present/absent 联合，未观察由 None 表达。真正的读取结果和成功写入结果携带路径、工作区根及版本，作为现有会话工具消息持久化。worker 只从当前请求实际可见的持久工具结果取版本；不增加内存版本表或第二份持久状态。压缩掉的观察不会被伪造恢复，缺少观察时只能创建不存在的文件。
- 覆盖和 edit 必须用上述观察版本。Host 读取当前字节用于备份，并核对其摘要等于观察摘要；不会将此刻取出的摘要冒充观察版本。准备记录同时保存工作区根，Supervisor 在副作用前核对，拒绝授权根换绑后的旧准备。新建以原子 no-clobber 发布，不能覆盖并发创建者。
- 写入复用文件路径校验、摘要和备份，改为相同目录中的私有临时文件完整写入/fsync 后原子发布。保留权限、所有者和扩展元数据；macOS 使用本机 SDK copyfile.h 确认的 fcopyfile ACL/XATTR 行为，真实文件验证元数据与内容保留。发布前失败保持原文件；发布后持久化未获确认则保持 unknown，不宣称没有发生副作用。保留现有人工 FileWrite 显式 expected_digest 契约。
- 未读取已有文件覆盖：真实 Host 旧行为将 keep 改成 overwrite，回归测试在旧实现失败、修复后通过。持续 ENOSPC：从 `62755303` 加载旧 write_file 运行同一真实文件测试，已有/新建两行均失败；当前实现保持原文件或不存在状态。授权根回归测试在加 guard 前实际写入、未抛拒绝，补 guard 后通过。
- 独立重读发现并修正了准备记录缺少工作区根的问题。检查覆盖输入 → 持久工具观察 → Host 备份/准备 → Supervisor 归属 → 原子写盘 → 新版本工具结果 → 后续写入/恢复。不存在新增执行循环或进程登记表。
- simplify-code changed 仅将本单元清理表达式改为普通 if；原子写入和版本保护按功能修复交付。simplify-test changed 的 15 个新增或调整声明全部保留（R=15，F/C/D=0），包括旧审批/检查点/路径契约；未删除测试。旧的私有原地恢复 helper 随原地写入路径被原子发布替换，不以删除失败测试取得通过。
- 最终定向：`test_workspace_files.py test_native_file_edit.py test_tool_checkpoints.py test_checkpoints.py test_native_execution.py test_native_output.py test_execution_p2.py test_output_retention.py test_session_model.py test_run_options.py`，120 项通过。Web 先构建再测试，24 文件 / 228 项通过；Pyright 0 错误，Ruff、架构（222 模块 / 5305 边 / 0 违规）、导入闭包、AI HTTP 替身探针与契约检查通过。无真实供应商调用。

## 时间单元契约与证据

- `RunOptions.time_zone` 接受 UTC 或 IANA Area/Location。Web/Electron 在原持久提交载荷中保存 Intl 报告的时区，重试及重载沿用原载荷。Python SDK 提供显式 time_zone；CLI 提供 --time-zone，CLI/TUI 默认从 TZ 或 /etc/localtime 的 zoneinfo 目标解析本机时区，无法确定时报告为空。
- 日期不是会话创建时的常量。会话首次准备该请求的模型调用时，用现有会话时钟采样并把 started_at_ms 写入原 Run；模型装配层按客户端时区转换日期。缺失时区明确标记“用户时区不可用，UTC 为显示回退”，本地时间意图要求澄清；不冒充用户时区。无效地区在产品上下文装配中拒绝，发生在供应商认证/调用之前。
- 同一请求的工具往返和恢复保持采样稳定，不按每个工具调用刷新系统前缀。新请求重新采样；新的用户插话在受理事务中刷新目标请求的采样，并采用新报告的时区。子任务继承父任务时区，在自身首次模型调用时采样。未报告新时区的插话保留已经明确知道的时区。
- 独立重读覆盖 Web 提交台账 → HTTP/RPC/SDK/CLI/TUI → 会话运行记录 → 产品 prompt → 中立模型请求，以及插话、子任务与数据库重开。没有在中立 AI、会话创建或进程环境中固化日期，没有第二个时钟状态库。
- 受控时钟覆盖上海/洛杉矶/缺失时区、跨日、新请求、工具往返后的数据库重开、用户插话与子任务继承。实际 SDK、CLI、TUI 通过真实 Host/worker 把三个指定时区持久写入会话；Web 现有丢回执后重试测试确认时区随原提交保留。
- 基线模型/会话定向 53 项通过。最终 `test_time_context.py test_run_options.py test_provider_wire.py test_provider_history.py test_session_branch.py test_memories.py test_model_catalog.py` 共 82 项通过；`test_native_time_context.py test_client.py test_tui.py test_product_cli.py` 共 11 项通过。Web 先构建再测试，24 文件 / 228 项通过；Pyright、Ruff、架构（223 模块 / 5321 边 / 0 违规）、导入、AI HTTP 替身与生成契约检查通过。未调用真实供应商。
- 两个 changed 审查完成；无额外纯重构候选。10 个新增或调整测试声明全部保留（R=10，F/C/D=0）。三个网络替身补充新可选参数，保留认证和记忆安全断言；没有通过删断言取得通过。

## 作业单元契约与证据

- 实施前 `test_execution_p2.py test_host_shutdown.py test_native_recovery.py test_lifecycle.py test_session_model.py` 定向基线 130 项通过；与任务起点一致，没有需要绕开的基线失败。
- `shell.run_in_background=true` 显式后台运行，返回稳定 job_id 的持久受理回执。回执的 exit_code=0 表示已受理，作业实际结果通过 job_list/job_output 和完成事件读取。前台命令仍以 timeout_seconds 为执行期限、默认 30 秒且最多 120 秒；后台执行也默认 30 秒，显式期限最多 86400 秒。job_output.wait_seconds 只是最多 30 秒的等待，截止或插话不停止命令。
- 复用唯一 Supervisor 的 scopes、进程 reservation、native runner 和退出证明。新增后台字段记录意图、启动回执、取消、通知和时间；没有另一份进程登记表。副作用先登记，再放行；回执先写入 SQLite 再回应。原调用身份和参数摘要去重，丢回执、重复提交和重连不再启动一次命令。内存 Task/Future 只承载已有执行与等待，不是作业状态真相。
- 在准入锁内从执行库限制每 profile 最多 16 个、每会话最多 4 个未结算/未清理的后台作业；原共享执行容量仍生效。后台容量拒绝发生在副作用前，模型得到明确的 background_capacity 工具结果；传输不确定性仍走原 unknown 路径。每次真实用户输入最多 8 次后台启动尝试，Step 记录预算归属，子任务及自动完成续办继承同一归属；重开数据库不重置。真实新输入或人工插话才建立新预算，完成事件不会自行取得新预算。列表优先显示活动作业，最多 64 条并明确 truncated。
- 请求回复、前台等待结束、turn 取消、页面断开和 worker 回收都保留后台作业。job_kill 记录取消意图，关闭确切运行通道并核对进程及已知后代，重复调用安全；不能确认退出时保留 cleanup_pending，允许重试。归档/删除会话及应用正常退出回收作业。取消正在等待 job_output 的 turn 会结束该等待，不取消对应作业。
- 宿主意外退出后，仍有原 Supervisor 持有可核对的进程时，接管保留真实 running 状态；Host 与 Supervisor 都丢失时，新监督器即使发现原 epoch 已关闭，也核对后台持久记录和进程事实，将未确认结果标为 unknown，处理残留且不重放。未知写效果继续使用现有 effect hold/显式核对机制，不因资源已退出就伪装成成功。承诺的输出日志继续可读。
- 完成后先向原 Host 投递表写入不可变 job_notice，再确认执行库通知标记。Host/worker 丢回执时复用相同事件与请求身份；日志过期不会改变通知摘要。通知只带作业身份、归属和终态，不附日志、不消费游标。缺失、已归档或已撤销工作区的会话不被通知重新激活。投递容量/会话队列满时保留重试。公开 Submit 无法伪造系统事件来源。
- 复用原 worker 调度与 wake。job_output 在每次等待前检查持久的后续人工输入，避免清事件与入队之间丢失唤醒；完成通知不算人工输入。HTTP 提供 jobs 列表、分页输出和显式 kill；SDK 对应 list_jobs/job_output/kill_job，CLI 使用 job.list/job.output/job.kill RPC，TUI 支持 /jobs、/job-output、/job-kill。Web/Electron 继续消费原 WS/快照、持久提交台账和生成契约，后台回执显示“后台已受理”，完成事件标为后台作业。没有客户端业务状态副本。
- 独立只读自审查重新追踪输入 → 预算/审批 → 持久意图/回执 → 进程 → 原始日志 → 完成投递 → 客户端 → 恢复/退出。发现并修正：关闭 epoch 不再等于所有资源清理；Host 更新检查和 Supervisor thaw 都必须核对未退出资源；健康快照优先保留未退出记录，cleanup_pending 仍计入活动任务。两个更新回归在修复前分别复现 DID NOT RAISE，修复后通过。还补齐取消等待的有限结算、任意合法 job_id 到有界合法请求 ID 的稳定映射，以及 HTTP 路径参数复用 JobId 类型校验。
- simplify-code changed 的 gate 为实际定向基线与当前 diff，范围只含本单元及上述生命周期消费者；没有额外纯精简候选，功能和缺陷修正按实际行为记录。simplify-test changed 保留 17 个新增或调整声明（R=17，F/C/D=0）：真实 IPC/原生进程与故障边界、持久通知/预算、原并行调度和 Web 投影分别保护不同契约。旧调度替身只补新通知查询的空响应，原九会话进展断言保留。
- 最终定向命令：`test_background_jobs.py test_job_notices.py test_native_jobs.py test_execution_p2.py test_host_shutdown.py test_native_recovery.py test_lifecycle.py test_session_p2.py test_run_options.py test_codemode.py test_model_code.py test_client.py test_tui.py test_output_retention.py test_native_output.py test_time_context.py`，230 项通过。覆盖成功/非零退出、日志增长、重复启动/取消、错误会话、无效输入、重连、完成通知、插话、turn 取消、worker 与 Host/Supervisor 死亡、unknown、未确认清理与重试、更新屏障。Web 先构建再测试，24 文件 / 229 项通过。Pyright 0 错误，Ruff、架构（224 模块 / 5359 边 / 0 违规）、导入闭包、AI HTTP 替身与生成契约检查通过。
- 容量拒绝的模型呈现补齐后，重跑 `test_native_jobs.py test_background_jobs.py test_job_notices.py test_run_options.py test_model_code.py`，34 项通过。真实会话启动四个后台命令后第五次拒绝，副作用标记未产生，前四个仍可逐一取消并取得退出证明。
- 长命令用可重跑的 `backend/.venv/bin/python backend/tools/verify_background_jobs.py` 验证。真实 native shell/Python 连续输出 126 个 tick：前台约 0.566 秒返回，断开再连接时命令自身报告运行 120.864 秒，前台观察时刻 122.044 秒仍 running 且日志可读，约 128.142 秒正常完成，退出码 0、resource_clean=true，重复回读一致。证据在本机 `.artifacts/native/jobs-qntw_dic/report.json`；报告由原 Runtime 核对全部所属进程退出。脚本按命令实测运行时间判定，不假定每个 sleep(1) 恰好耗时一秒。
- 所有模型驱动使用 faux 或本地 HTTP 替身，真实证据指本机进程/文件/SQLite/IPC；未调用付费供应商，未做新 DMG 或真实浏览器/Electron GUI 运行验证。没有 OS 沙箱、跨宿主迁移或重启后重放未知命令的承诺。
- 最终 `npm run check:workspace`、`git diff --check` 通过。阶段末资源普查退出码 0，约 250.35 GiB 可用，无 scope 内的泄漏，reclaimed/build_allowed 均为 true；scope 仅为脚本归类的所属进程、VM/临时目录、package 保留数与磁盘空间，不据此宣称整个系统无其他资源。脚本未删除目录，也未停止其他任务。

## 交付边界

本轮只提交 AmazMe dev 的完整变更单元，不推送、不合入 main、不建 PR/标签/Release，也不执行公证。没有需隔离的原有或并行修改。所有实现提交完成后，重新核对 DSH 的 master、干净状态和祖先关系，只允许 `git merge --ff-only 22ddee3792402c3e70ec5f86a63c3e3e895a2f60`；不改用新的参照终点，不触碰 master-local。
