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
| 文件：固定终点 `packages/fs/tool-fs/src/{read,edit}.ts`、`packages/fs/fs-observation-policy/src/index.ts`、`packages/fs/fs-local/src/fsio.ts` | 分段读、唯一字面量替换、以实际观察版本做 CAS；区分未观察/不存在/存在。这些源码在起点与终点间无变化，属于补足既有能力 | 采用；复用 `workspaces/files.py`、Host 文件准备和持久会话。人工文件 API 保留显式 expected_digest 契约。实施及验收记录随文件单元补充 |
| 作业：`70eab5706e`、`ed645016cd`、`7854778639`，以及固定终点 `packages/jobs/{jobs-local,tool-jobs}`、`packages/shell/tool-bash` | 领先提交增加完成通知、避免通知无端消费日志游标、用户插话结束 job_output 等待；后台注册本身在起点已存在 | 采用；复用唯一 Supervisor、execution SQLite、持久投递。不会移植 DSH 内存 registry，也不会把前台执行超时改成自动无限后台。实施及真实超过 120 秒验证待作业单元补充 |
| 时间：`22f8be30a1`、`2f30c684ac`、`1696816d2c`，固定终点 `packages/context/time-context/src/{index,request-zone}.ts` | 时间按请求装配，恢复浏览器时区先等待真实投影；领先范围包含恢复修复 | 采用产品语义，由 Python 请求装配拥有；客户端只报告时区。用受控时钟验证跨日、缺失时区与恢复；实施记录待时间单元补充 |
| guard：固定终点 `packages/guard/timeout-policy/src/index.ts` | 超时传播取消并等待实际结算，不放弃未终结的 promise；该核心源码非领先范围新增 | 保留 AmazMe 原有真实退出核对及 unknown/cleanup 屏障；作业单元验证，不另加循环 |

本轮不引入计划模式、ask_user、todo、自动标题、重复调用提醒、跨会话检索、goal、LSP、browser-use、worktree、ACP 或新的 OS 沙箱。现有审批、会话、工作流、工作区、计算机操作与排程路径保留各自职责；这些路径的存在不等于覆盖 DSH 同名功能。新交互与扩展需要独立需求和验收，均延期，不借本轮改写产品。DSH 的 TS 插件运行时、市场、Agent Teams、遥测扩展和第二套 run_code 不适用当前 Python 执行所有权。

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
