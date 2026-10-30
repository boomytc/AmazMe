# 上游对齐

本页保留历史移植与验收记录；其中测试命令和脚本路径对应当时版本，已移除的设施从 Git 历史查询。当前开发入口见 [AGENTS.md](AGENTS.md)。

实现来自 [Pi](https://github.com/earendil-works/pi)。最近核对基线为 `50af8c160153e3721a18b1a046a4adf201635861`；按当前 Python 产品的职责吸收适用行为，OAuth 客户端 ID、回调和供应商请求身份保持原样。当前执行与持久化契约见 [本机方案](docs/python-backend-plan.md)，完成状态见 [任务表](docs/python-backend-completion.md)。TS 仅保留客户端、TUI、纯呈现与 QuickJS helper。

旧产品线的移植记录保留在 Git 历史；当前行为以本仓源码和上述契约为准。

QwenPaw 的最近核对基线为 `c26d31c0688aa9cce9bc1aef688177d2e14e25df`。它提供增量参照，不替代本仓的 Python Host 与客户端职责。

## 2026-10-30 QwenPaw 增量核对

范围为 `cee4c67e9a9a871c3730156ff81b3f8993fe97b0..c26d31c0688aa9cce9bc1aef688177d2e14e25df`，共 41 个提交。终点固定为本轮 fetch 后的 QwenPaw `origin/main`，按当前入口归并处置。

| QwenPaw 提交或范围 | 处置 | 当前依据 |
| --- | --- | --- |
| `74b3c9b9` | 吸收 | `ai.client` 限制启动和两次有效进度之间的等待，默认沿用 60 秒。仅心跳或空元数据不延长期限，推理、签名和工具输入使用内部 `StreamProgress`，公开流仍只有文本与完成结果。消费方处理结果的时间不计入。 |
| `aa669eed` | 部分吸收 | 产品模型边界只在首次 HTTP 413、尚无公开输出且存在历史图片时，以请求副本省略最后一条用户消息之前的图片，再调用一次。当前回合的用户和工具图片保留。OpenAI SDK 的 413 统一为原生 adapter 使用的错误码。每次模型调用至多恢复一次，不写入历史省略标记，不改原消息或 SQLite。其他错误沿用原处理。 |
| `abadf54d`、`0e2a7a54` | 已覆盖适用行为 | `ai/reasoning.py` 按 Pi 目录的 `thinkingFormat` 和等级映射生成关闭字段，不向未知模型同时发送多个协议的参数。当前配置没有 QwenPaw 的任意 `generate_kwargs` 合并层，推理等级从同一份请求配置产生。 |
| `a2b7d8b7` | 已覆盖适用路径 | Host 投递固定会话模型，session 接纳提交时固定本回合配置，模型动作使用 `action.config`；手动压缩也先解析会话模型和账号。没有独立的标题生成器或媒体模型回退路径。 |
| `c935c7fe` | 已覆盖 | 当前技能从本地目录导入，`copytree` 和 `copy2` 保留二进制文件，只有 SKILL.md 按文本验证。没有 GitHub 内容转文本的下载层。 |
| `6de03913`、`a6ad25a0` | 不适用 | 当前没有技能池下载、广播任务或内置 make-skill 发布脚本，保留本地导入和编辑入口，不新增下载任务服务或上游原生 CLI 依赖。 |
| `3d35ad12`、`7db18380` | 保留 | 当前 Code Mode 使用隔离 QuickJS，Supervisor 提供已绑定的 MCP 和插件工具，内部调用经 Host 和 session 审批。图片独立保存在 step_images，普通事件投影保留文字；本轮不新增 QwenPaw 的 Python REPL 或 React 媒体预览卡。 |
| `04fe12d4` | 不适用 | 当前审批使用确定性工具策略，没有把完整脚本送入 JEV 的审批决策路径，不引入针对 Python 源码披露的预检或新的模型审批。 |
| `505a5c6f` | 已覆盖适用行为 | session 数据库的 `Database` 已由单个 executor 和连接持有，检查文件身份并在 owner 退出时关闭；没有按每次请求新建上游 HistoryStore 的路径。 |
| `353b7033`、`8d92e52e` 的轮询部分 | 已覆盖适用行为 | 会话切换同步 retire 旧连接，后续历史、健康轮询和元数据响应核对连接代际。当前没有独立的侧栏目录定时轮询，不增加预加载或第二套切换状态。 |
| `e35570c5` | 保留 | Electron 主进程管理本次启动的 Python 子进程并共享给窗口，启动解析 build_id 和宿主身份，源码桌面构建有指纹核对。本轮不引入 Tauri 独立 daemon 的版本替换和旧进程接管机制。 |
| `08f19d29` | 已覆盖适用能力 | 当前 openai-codex 已使用 Pi 的订阅 OAuth、账号存储和刷新入口，模型请求保留 Pi 身份，不另建 ChatGPT 凭据库或改写客户端 ID。 |
| `504a6790` | 保留目录来源 | 刚刷新的 Pi 快照已包含 Claude 5.5、Gemini 4、Kimi K3.1、MiMo 2.6 和 MiniMax M3.1 等主要新增项。QwenPaw 的 GLM 5.3 FlashX 等少量手工预设未混入 Pi 快照，继续使用当前自定义连接能力。目录核对不代表供应商可用性验证。 |
| `0a62d632` | 不适用渠道拆分 | 当前没有 QwenPaw 的聊天渠道系统。插件已在独立 gate 中加载，执行和清理由 Supervisor 管理，不迁入其渠道 SDK、依赖安装器或整套子进程协议。 |
| `fa319381`、`5d4f8fd9`、`85a60406` | 保留当前插件边界 | 当前插件从固定入口在子进程内编译加载，不在 Host 里刷新第三方 import finder，也不安装或共享 QwenPaw 插件 SDK 的依赖环境。上游依赖观察缓存和 Windows 父进程 HANDLE 监听不适用于当前 POSIX gate。 |
| `ced7143f` | 不适用 | 当前插件包登记本地 Python 入口，没有下载远端 ZIP 的 HTTP 路由，不新增无法触发的下载异常映射。 |
| `6ed55aa3`、`314a5916` | 保留 | 当前记忆是工作区限定的 SQLite 记录与注入规则，不是 ReMe 的图片、标签文件和决策压缩系统。本轮不替换记忆存储或新增 ReMe 依赖。 |
| `b12b06ed` | 不适用 | 没有上游推送收件箱和已读状态过滤入口。 |
| `2fdaa3a5`、`e6ab2fb6`、`9e59502c`、`507f63b7`、`8d92e52e` 的其余界面部分 | 不直接移植 | 数字步进器、agent 创建表单、通用媒体错误卡、工具卡图标和浏览器布局使用上游 React 组件及样式。本仓使用现有 DOM 呈现，仅面向桌面宽窗。 |
| `02f6147e` | 不适用 | 当前没有邮件账号域名拼接或邮件监听入口。 |
| `45c754ee`、`bfeebec5`、`e50446c1`、`9a216545` | 不适用 | 当前没有 QwenPaw Creator 的脚本导入、发布审阅、工程日志和 Windows 存活探测入口。 |
| `c26d31c0` | 已无对应旧接口 | 当前工作区 API 管理授权与文件操作，会话导入导出使用自身 JSON 契约，没有整工作区 ZIP 上传下载接口。 |
| `9b1934f6`、`07dc3f6a` | 不移植测试资产 | 上游新增前端套件及修复记忆标签测试夹具。本仓按当前有限验收约定使用临时脚本，验收后删除。 |
| `199e9558`、`f6772f7d`、`f496ef34`、`151be0f5` | 不适用工程与发布入口 | 上游发布构建、Windows 安装准备、网站 quickstart 和评测站点不属于当前本机构建流程，不增加 workflows、安装器或发布操作。 |

实现提交为 `b8c4b195`。模型流从 worker、连接检测、压缩到 adapter 和 SSE 读取都显式关闭；超时、取消或消费方提前退出时释放 HTTP 请求。Anthropic 在 message_stop 后关闭读取，Google 保留流尾用量读取。

有限验收通过 Ruff、Pyright、契约漂移检查、工作区检查、diff 检查和 Python wheel、sdist 构建。临时脚本经本机 HTTP 服务实际驱动 Chat Completions、Responses、Codex Responses、Anthropic 和 Google adapter，覆盖延迟响应头、仅心跳、持续推理、工具参数增量、慢消费、取消及提前关闭。另核对 Google 流尾用量、413 后的一次恢复、当前回合图片保留、原消息不变，以及非 413 和第二次失败不重发。

临时脚本与构建输出已删除，没有读取用户 profile 或账号，也没有保留测试依赖和运行入口。资源普查退出码为 0，在报告的 scope 内 `leaks=[]`、`reclaimed=true`。没有连接真实供应商，未验收桌面或浏览器整条交互路径，也未在 Linux、Windows 运行。

## 2026-10-30 增量核对

范围为 `d5b3de22d0e24a3e9c38a9410d3329b099717283..50af8c160153e3721a18b1a046a4adf201635861`，共 161 个提交。终点固定为本轮 fetch 后的 Pi `origin/main`。以下按行为归并，核对到该基线不表示移植了 Pi 的全部能力。

| Pi 提交或范围 | 处置 | 当前依据 |
| --- | --- | --- |
| `3bae85274` | 吸收 | 列表、设置和补全面板共用分页索引；聚焦组件用 `capturesViewportInput` 接收全屏分页键。Python 会话的外层组件转发编辑器状态，补全打开时分页优先于图片粘贴。 |
| `deb12d78e`、`86dc686cf` | 吸收 | 解析 Kitty F1–F12 及修饰和释放事件，忽略未映射的功能键；原生 Shift 检测同时覆盖 Return 与 ESC+Return。 |
| `fa1685152`、`cd1ea342a`、`2ce9d527d` | 吸收 | 裸链接遇中文标点停止；过宽的二维公式显示源文；换行正确丢弃带样式的空格并关闭删除线。 |
| `89c921d8b`、`19ce8059c`、`f09d01b85` 的 TUI 部分 | 吸收 | 标题与程序状态共用控制字符过滤；普通模式移除行首 OSC 133；Orca 明确声明 Kitty 协议时启用图片。 |
| `e7a0df27c` | 吸收 | 必须缩放时先比较 PNG 与配置质量的 JPEG，选择较小且满足限制的编码，之后才降低 JPEG 质量或尺寸。 |
| `ae823bc0b` | 吸收 | Python BM25 将完整工具名及 `__` 后缀命中排在描述命中前，沿用普通查询评分与同分顺序。 |
| `363ad78bf`、`177e2ad7e`、`2e0f175bd`、`44f6851b7` | 吸收 | 使用终点生成器刷新 Python 模型快照，包括 Terra、OpenCode 分协议端点和 OpenRouter Claude latest 的 Anthropic 协议。 |
| `908aa7b74` | 吸收 | MCP OAuth 默认 `auto`，支持公开客户端元数据文档时使用 Pi CIMD，否则 DCR。自定义身份或回调走 DCR，显式 `cimd` 仍要求服务器支持；旧 DCR 凭据使用原存储键。注册身份变化时经操作 guard 原子清除旧 token，匹配的 DCR 注册在重新登录时保留。Python 与生成的客户端契约同步。 |
| `89c921d8b` 的 OAuth、认证文件和流索引部分；`81d6759fc` | 已覆盖或无对应协议 | 设备登录已调用 `trusted_url`，MCP 元数据与请求使用 HTTP URL 校验；凭据用私有写入。Responses 本来就将工具放在顶层。当前不支持 `pi-messages`。 |
| `807a5c051`、`b9e3eef6c`、`6fed3cfb9`、`c466a3595`、`50d9f823e` | 已覆盖适用行为 | 会话由 SQLite 单 writer 提交；当前没有 Pi JSONL 内存镜像或 `setActiveTools` 扩展 API。压缩经账号所有者解析认证，执行输出采用有界预览与分段日志。现有终端序列解析接受完整 CSI 参数范围。 |
| `842c73170`、`d3398f826`、`c719d5b08` | 保留现有协议范围 | 当前没有 Bedrock 协议，也没有 Pi 的模型自动重试和溢出后自动压缩恢复循环。不为这些入口增加无法触发的分支。 |
| Chord、Durable、env daemon、包管理、TS 扩展、HTML 导出与上游工程变更 | 不适用 | Python Host、会话 worker、Supervisor 和 SQLite 继续拥有业务状态及资源。本仓没有 Chord v2、Pi env daemon、npm 临时扩展缓存和 Pi HTML 导出，也不新增上游 CI 或发布设施。Windows 路径修复涉及的上游包管理与信任存储没有对应消费者。 |

模型数据从固定终点的隔离源码运行 `node packages/ai/catalog/generate.ts --strict --data-only` 生成，再由 `backend/tools/sync_pi_models.py --source <data目录>` 导入。聊天模型由 1285 项变为 1281 项，新增 17 项、移除 21 项、更新 159 项元数据；分类器快照同批刷新。该结果是公开目录快照，不证明真实供应商可用性。

实现提交为 `4ad6ec9c`（TUI）、`46946086`（图片编码）、`1b7e951e`（工具搜索）、`850226dd`（模型目录）和 `7b354f3c`（MCP OAuth）。

有限验收使用临时脚本，完成后删除。TUI、coding-agent、Web 逐包构建，Python wheel 和 sdist、Ruff、Pyright、TypeScript 类型与工作区结构检查通过。构建产物的定向验收覆盖分页、补全与图片粘贴冲突、标题过滤、普通模式标记、Markdown、Orca 能力和真实 Photon 图片编码。

独立 profile 经本机 HTTP OAuth 替身完成实际回环登录，覆盖自动 CIMD、DCR 回退、显式配置、自定义回调、无 `iss` 时的服务器专属回调、旧 DCR 注册重用、凭据保存后重开、取消 guard 与私有文件权限。未连接真实 MCP 授权服务或付费模型，也未在实体终端及 Linux、Windows 验证。临时 profile、服务和验证文件已清理；资源普查退出码为 0，在报告的 scope 内 `leaks=[]`、`reclaimed=true`。

## 2026-10-26 增量核对

范围为 `be14d9732f98fcc33929cf103a92b96afaa6523e..d5b3de22d0e24a3e9c38a9410d3329b099717283`，共 55 个提交，含 1 个合并提交。目标取自本轮 fetch 后的 Pi `origin/main`。

“吸收”表示修改了当前实现；“已覆盖”表示核对到等效行为；“保留”表示当前设计与上游仍有差异；“不适用”表示当前产品没有对应入口。核对到该基线不表示完整移植 Pi 的全部能力。

| Pi 提交 | 处置 | 当前依据 |
| --- | --- | --- |
| `74f468640` | 不适用 | Pi PR gate 的机器人白名单；本仓不新增 GitHub workflows。 |
| `27cc6bfc0` | 吸收 | `native_execution.stop_tracked` 在 macOS 先按已追踪身份暂停父进程，再终止进程，避免 shell 被子进程退出唤醒后继续执行；保留 PID 与创建时间核对。 |
| `9359adf0c` | 不适用 | Pi HTML 导出的 system 消息；本仓导出为 `amazme-export/1` JSON，系统提示由配置持有。 |
| `64627838b` | 不适用 | 旧 TS Markdown transformer 扩展接口；当前插件为 Python factory。 |
| `1c720d285` | 已覆盖 | 当前导出遍历 SQLite 会话与消息，不递归遍历 Pi JSONL 树。 |
| `c60de42e9` | 保留 | 没有 `pi.exec`；Python runner 持久记录失败类别与清理结果，继续使用本机执行回执。 |
| `7151099d0` | 已覆盖 | Web 授权页展示设备码，浏览器动作由用户点击触发，不自动打开或写剪贴板。 |
| `90d5cf784` | 不适用 | Pi 登录对话框文案；本仓使用自己的授权页面。 |
| `8c03fef4d` | 吸收 | TUI fuzzy 同时评分连续匹配；Python 会话内容搜索原本逐条做字面匹配，不拼接 UUID 与全文。 |
| `936e5f40a` | 吸收 | 移除 evals 未使用的 `autoevals` 及锁文件中的独占依赖。 |
| `42cb822f1` | 不适用 | Chord 共享 watch handle；当前没有 Chord 执行宿主。 |
| `906e1302f` | 不适用 | Pi Bun standalone 构建；本仓使用 Python 与 Electron。 |
| `14c811841` | 不适用 | `pi-messages` 协议的 responseModel；不在当前 `ProviderApi` 内。 |
| `a1836b06c` | 已覆盖 | `scripts/package-artifacts.mjs` 已同时接受 npm pack 的数组和按包名组织的对象，并核对包身份。 |
| `a2fd25f56` | 不适用 | Chord Watchable；当前事件边界是 Python HTTP/WS。 |
| `3141dfdcf` | 合并记录 | 上游 watchable 分支合并；相关行为按本表各独立提交核对。 |
| `e3bc05e87` | 保留 | Python Anthropic adapter 按请求设置 effort，尚无 Pi 的逐消息 effort 标记；仅将顶层改成 low 会改变实际推理等级，因此不单独移植该字段值。 |
| `9ffd27cfa` | 已覆盖 | 固定版本 MCP SDK 的 OAuthMetadata 使用 AnyHttpUrl，当前请求另经 `mcp_secure_url`；补充非法协议回归。 |
| `6dfb54678` | 不适用 | 没有启动时自动安装 npm 扩展；Python 插件加载与资源诊断使用现有会话路径。 |
| `8a2ebd385` | 吸收 | TUI Markdown 的窄列引用边框停止条件与深层引用回归。 |
| `36be9c612` | 已覆盖 | Python shell 先收集有界字节，再统一解码，不逐块解码 UTF-8。 |
| `ede2c9b46` | 不适用 | Pi provider/MCP/CLI 文档；本仓使用 Python 产品文档。 |
| `bc73eb8b1` | 吸收 | 移除 Rex 图片能力的过时注释。 |
| `ff6896471` | 吸收 | 全屏选词采用相同附加词字符，并补全路径与标点回归。 |
| `c8ec752cf` | 不适用 | 没有 fd/rg 自动下载入口，工具使用本机 PATH。 |
| `c55972086` | 不适用 | 上一项的 Pi changelog 补记。 |
| `3953e9ef4` | 不适用 | 旧 TS todo 扩展示例不在当前产品中。 |
| `5e106ab1c` | 不适用 | Chord NativeWatchable；没有对应运行时。 |
| `606af8662` | 已覆盖 | 当前模型目录包含显示名称，Web 模型选择器直接显示 label。 |
| `f3fa8bd92` | 已覆盖 | Python faux 不模拟缓存读写，输入量没有与 cacheWrite 重复记账。 |
| `8ddc44ec8` | 已覆盖 | 分支复制使用 SQLite 事务，不分次追加 JSONL 文件。 |
| `ed76cca69` | 已覆盖 | `test_session_branch.py` 检查分支后的实际消息、恢复和独立继续执行。 |
| `7314819f0` | 吸收 | Gemini 工具 schema 中的字符串与数值 const 投影为单值 enum。 |
| `a7b94a03f` | 吸收 | 投影只进入 schema 关键字，保留 enum/default/examples/扩展元数据，以及名为 const 的属性名。 |
| `4464442f9` | 吸收 | Kitty 图片的占位行含边框或旁列文字时仍能裁剪。 |
| `1c8cb1781` | 吸收 | 图片回查不超过已登记图片行高的上界。 |
| `a8fe8e0ad` | 不适用 | Pi 历史 changelog 补记；本仓保留自己的产品历史。 |
| `e9c3ac9d9` | 不适用 | Pi 历史 changelog 署名调整。 |
| `acf83acfd` | 不适用 | Pi 历史 changelog 署名恢复。 |
| `136b87e8a` | 不适用 | Pi changelog 工作规则；本仓遵守自己的 AGENTS.md。 |
| `f715a15c1` | 保留 | Python adapter 保存有界原始参数，完成后统一解析，没有逐 delta 重解析部分 JSON 或 Chord partial 文档的消费接口。保留当前流协议。 |
| `da412b039` | 不适用 | Chord appendText 与 Durable partial commit；当前无 Delta 文档引擎。 |
| `1e42501bb` | 不适用 | Durable partial-commit 跑分夹具。 |
| `d8d99950a` | 不适用 | Chord PendingOps/Watch 合并；当前流使用有界重放、ACK 和快照恢复。 |
| `bdb151774` | 不适用 | Chord fuzz 测试的 CI 超时。 |
| `1de2d7ade` | 吸收 | 使用目标提交的模型生成器刷新 Python 快照，接入 K3.1 Pro/Highspeed 的 K3 effort 与兼容参数。 |
| `f321e5bdd` | 不适用 | Chord Delta 文档。 |
| `d0aa218cb` | 不适用 | Chord tracker/applyImmutable 容器复制优化。 |
| `6c2fd73b0` | 保留 | Python 在副作用前提交调用意图，preview 在 worker 中限频；不引入 Durable deferred storage 的可见性与延迟落盘语义。 |
| `38ff99177` | 不适用 | 当前 Python 工具返回协议没有 ToolControl.handoff；委派与工具结果使用自己的状态机。 |
| `911fbab32` | 不适用 | 没有 pi-test.sh；工具环境由白名单构造，模型账号由独立账号库提供。 |
| `5f960a0e2` | 不适用 | 没有将 agentDir 传给 npm prefix 的扩展安装入口。 |
| `984cf6643` | 不适用 | 当前 provider ID 在类型边界限制为小写字母、数字、点、下划线和连字符，不接受斜杠；保留现有标识契约。 |
| `0eea54f11` | 已覆盖 | `scripts/check-workspace.mjs` 在入口图比较前已将反斜杠规范化。 |
| `d5b3de22d` | 吸收 | 助手消息在 SessionStore 接纳模型结果时记录该次请求的 thinking，跨重启和后续回合保留，不信任响应自行上报的等级。 |

模型快照由目标提交的 `packages/ai/scripts/generate-models.ts --strict --data-only` 在隔离源码目录生成，再由 `backend/tools/sync_pi_models.py --source <data目录>` 导入。此次读取公开目录，聊天模型由 1280 项变为 1285 项，包含 20 项新增、15 项移除和 35 项元数据更新；分类器快照同批刷新。价格和目录是本次生成时的快照，不是供应商可用性验证。

实现提交为 `3e0f84ca`（TUI）、`a69f848d`（模型与协议）、`7e283d78`（shell 取消）和 `8653b33f`（评测依赖）。

本轮验证通过 TUI 全包、coding-agent 383 项（另跳过 1 项）、evals 32 项、后端定向回归 149 项、打包与工作区工程测试 42 项，以及逐包构建、Python wheel/sdist、Ruff、Pyright、TS 类型、契约生成和工作区检查。搜索与 shell 取消回归已确认旧实现失败；真实 shell 的退出、暂停失败回退和既有用户服务隔离均有运行证据。资源普查的受检范围无泄漏。没有发起真实模型调用，没有验证 Linux/Windows 的实际终端，没有发布或推送。

## 2026-10-26 QwenPaw 增量核对

来源为 [QwenPaw](https://github.com/agentscope-ai/QwenPaw)，范围是 `0db9a8e625e73917a0d113e255b3147134022db8..cee4c67e9a9a871c3730156ff81b3f8993fe97b0`，共 16 个提交。目标取自本轮 fetch 后的 `origin/main`。

| QwenPaw 提交 | 处置 | 当前依据 |
| --- | --- | --- |
| `ce748971` | 部分吸收 | 工具参数进入呈现前限制原文长度、节点数和深度，格式化结果再次限长，复制保留完整原文。其他 React 控件、渠道、语音与移动端布局没有对应入口，不移植。 |
| `fdf7e024` | 吸收 | 删除成功后立即使原连接失效、移除本地会话和 URL，再刷新目录。旧目录响应与迟到历史不能恢复已删除会话或重启轮询。 |
| `d905bf24` | 不适用 | 发布分支同步主要涉及上游工作流、Docker、安装器与插件依赖下载。本仓不新增 workflows，不在插件加载时运行 pip，也不沿用该发布链。 |
| `b24f729d` | 不适用 | 当前 `web_tools.py` 请求远端工具并接收正文，没有 html2text 依赖或本地 HTML 转 Markdown 入口。 |
| `064d256e` | 不适用 | 组织 Hub 的模型代理、预算和恢复窗口不在当前产品内。模型 adapter 保留自身超时与错误契约。 |
| `d9826425` | 不适用 | 当前消息媒体契约只有图片，不发送视频或音频，不增加无法触发的视频降级分支。 |
| `ead6c69a` | 不适用 | Tauri sidecar 共用旋转日志句柄。当前 Electron 启动 Python，没有相同的 Python FileHandler 与 stdio 双重打开路径。 |
| `a4501e76` | 不适用 | 上游 nightly 页面测试与选择器。本仓使用自己的 DOM 测试和 Python 浏览器验证器。 |
| `86ef9dba` | 不适用 | PawApp sidecar 的测试探针，没有相同服务。 |
| `d2ca7030` | 不适用 | 上游 advisor 与 TUI 测试的跨平台断言，没有相同测试夹具。 |
| `6db1eaa8` | 不适用 | 上游决策模型 sips 预检测试，没有相同入口。 |
| `33f04faf` | 不适用 | 组织 Hub 的模型策略表单与刷新覆盖，没有对应的治理页面。 |
| `ffce7b1d` | 已覆盖适用部分 | 当前草稿按真实会话 ID 存入页面内存，提交回执按草稿对象和修订号清空。补验切换与迟到回执隔离；保留当前刷新后不恢复未发送草稿的设计。 |
| `95aa68f6` | 不适用 | 当前侧栏没有固定高度的虚拟列表，不存在来源组标题高度估算。 |
| `b501aca9` | 不适用 | 当前推理等级由菜单选择并随每次提交发送，没有滑块或独立的会话推理设置写队列。全局偏好已有串行保存与修订校验。 |
| `cee4c67e` | 保留 | 当前多窗口共用 Electron 进程内的 Python Host，关闭与退出经生命周期协调，更新有安装锁。本轮不改成 Tauri 的独立 daemon 或多个独立桌面进程。 |

删除链路的真实浏览器验证还发现受管 `writer.lock` 和 `worker.log` 未列入目录删除白名单，导致正常会话返回 `branch_cleanup_refused`。运行时文件创建与受管文件集合现在共用 `SessionRuntimeFile`，删除仍拒绝未知文件与额外目录并保留工作目录。不增加对 `artifacts` 等目录的递归清理。此修复补齐了上游删除行为在本仓的后端闭环。

验证命令为 `npm run build --workspace @amazme/web`、`npm test --workspace @amazme/web`、`npm run typecheck --workspace @amazme/web`，以及 `backend/.venv/bin/python backend/tools/verify_session_page.py`。删除竞态、参数展示预算与写锁删除均确认旧实现失败。普通参数、非法 JSON、Unicode 截断、删除拒绝、刷新失败和跨会话迟到响应有定向回归。

实现提交为 `50f238f6`（删除连接隔离）、`18bfb64a`（参数展示预算）和 `732f245c`（运行文件归属与真实页面验证）。本轮 Web 全包 228 项、后端定向 89 项测试通过，后端范围为 `test_client_management.py`、`test_session_lock.py`、`test_execution_p2.py`、`test_page_boot.py` 与 `test_session_branch.py`。Web 构建、TypeScript 类型检查、Ruff、Pyright、契约漂移和工作区检查通过。Python wheel 与 sdist 通过 `uv build --project backend --out-dir .artifacts/python-qwenpaw --offline` 完成。

真实 Chrome 验证通过会话草稿切换、删除确认后挂起列表刷新、旧会话无迟到轮询或重连、刷新后恢复剩余会话草稿。删除 HTTP 返回 200，页面无 JavaScript 异常。报告与截图位于本机 `.artifacts/native/session-page-*/`，运行器按两份上限保留。结束后的资源普查在受检范围内无泄漏。

旧 `backend/tools/verify_web.py` 仍使用已移除的 `#create` 等选择器，未作为本轮通过依据。新的定向验证器使用真实 Chrome、Python Host 和隔离的 faux profile，保留报告与截图，并在结束时核对资源退出；不依赖真实模型账号。此次没有验证 Linux/Windows，也没有发布或推送。
