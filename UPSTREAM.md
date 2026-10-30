# 上游对齐

本页保留历史移植与验收记录；其中测试命令和脚本路径对应当时版本，已移除的设施从 Git 历史查询。当前开发入口见 [AGENTS.md](AGENTS.md)。

实现来自 [Pi](https://github.com/earendil-works/pi)。最近核对基线为 `d5b3de22d0e24a3e9c38a9410d3329b099717283`；按当前 Python 产品的职责吸收适用行为，OAuth 客户端 ID、回调和供应商请求身份保持原样。当前执行与持久化契约见 [本机方案](docs/python-backend-plan.md)，完成状态见 [任务表](docs/python-backend-completion.md)。TS 仅保留客户端、TUI、纯呈现与 QuickJS helper。

旧产品线的移植记录保留在 Git 历史；当前行为以本仓源码和上述契约为准。

QwenPaw 的最近核对基线为 `cee4c67e9a9a871c3730156ff81b3f8993fe97b0`。它提供增量参照，不替代本仓的 Python Host 与客户端职责。

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
