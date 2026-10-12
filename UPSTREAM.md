# 上游对齐

实现来自 [Pi](https://github.com/earendil-works/pi)。本文件记录当前对齐的上游基线、基线之后已处理的提交、刻意偏离和跟进方法，供后续吸收改进时使用。

## 当前基线

对齐到 pi 提交 `0cf65d2bf`（2026-10-06），包含 v1.0.4 的全部内容。此前已处理到 `1cedd3272`（2026-10-08，发布 v1.1.0），随后核对并处理它之后至 `42a3497d0`（2026-10-09）的 12 个提交。本轮核对 Pi 本地 `main`（`ea448f454`）到 `origin/main`（`427052247`）领先的 25 个提交：吸收 22 项，另外 3 项保留本地设计或因仓库流程不适用而跳过，具体处置见下表。

基线之后已处理的提交（按 pi 提交顺序）：

| pi 提交 | 说明 | 处理 |
| --- | --- | --- |
| `9f013cf59` | 自更新后清理旧的 managed releases | 吸收 |
| `f6127a1bf` | llama.cpp 原生决策模型（`typesafe-system-one`） | 吸收 |
| `9ad083102` | 登录时可用 `agentName` 自报名 | 吸收，默认身份维持 pi（见下） |
| `1ffb6bd62` | 独立二进制禁用 .env 自动加载 | 吸收 |
| `0cf65d2bf` | Codex `originator`/`User-Agent` 允许被调用方覆盖 | 吸收 |
| `428a12bc7` | 批准贡献者（GitHub Actions bot） | 跳过，仓库治理，AmazMe 无 `.github` |
| `23cf2b948` | 统一 npm 包产物校验，重写发布与本地安装脚本 | 吸收产物校验和本地安装设计；本仓库的 `scripts/package-artifacts.mjs` 按运行依赖闭包打包、裁剪当前锁文件并用 `npm ci` 安装，eval 安装器已去掉悬空旧脚本引用 |
| `ddaa0a034` | `--tools` 接受 `+name`/`-name` 条目 | 吸收 SDK、CLI、设置与重载语义；默认 Durable TUI 共用选择计算并持久化激活及调用边界，补齐提前校验、动态注册、分支恢复和同名扩展回归。原生 MCP 与 codemode 已接线并通过正式安装入口验收 |
| `56b25ff4e` | 对齐 `docs/message-types.md` | 待同步文档；保留为整体文档审计项 |
| `8b5708dbb` | 重试 `server_busy` 瞬时错误 | 吸收 |
| `83c9e2645` | 全屏选区在 transcript 重建时清理 | 吸收 |
| `68ccef176` | durable 复用已扫描的 context 范围 | 吸收 |
| `b0114ef5f` | durable 在 `ToolExecutionApi`/`HookApi` 暴露 `models` | 吸收 |
| `76f6c06da` | durable 可读更早条目的 context | 吸收 |
| `18336987a` | `outputPad` 覆盖所有 transcript 块，`!!` 头部保持 dim | 吸收，`!!` 颜色本仓库已在 `e20383c` 修正，只取 `outputPad` 部分 |
| `27075fe07` | context 估算改为 3.5 字符/token | 吸收 |
| `269121616` | codemode 查找助手在描述里标注 async | 吸收 |
| `311f0e020` | 随估算调整输出上限断言 | 吸收，与 `27075fe07` 同批 |
| `2989eb581` | Bedrock Converse 传 OpenAI 推理档位 | 待落实 Bedrock 上的 GPT 推理配置；整体产品跟进项 |
| `636703a0a` | durable `context()` 截止点改为 options 对象 | 吸收，与上面三项一起（破坏性改动落在同一批） |
| `36a686ee8` | 记录响应、工具执行与 durable 任务的时间 | 吸收 |
| `43d376399` | Radius 目录改用网关目录，不再叠加内置基线 | 吸收 |
| `4dd2af42c` | 存储扫描支持指定顺序，游标携带顺序 | 吸收 |
| `3ba22ce17` | AssistantMessageEventStream 恢复对普通事件流可赋值 | 吸收，WeakMap 方案随后被 `f284a2460` 换回私有字段，净效果落在下一行 |
| `f284a2460` | 响应计时用回私有字段；proxy 与测试改用真实流 | 吸收 |
| `92216fa15` | 模型上下文由初始系统消息打头 | 吸收 |
| `4c28a6865` | 提高共享存储扫描模块的根入口预算 | 吸收检查设计到 `scripts/check-workspace.mjs`，校验 AmazMe 的实际入口和源码依赖预算 |
| `fe11328b0` | faux 提示缓存按消息比较，用量数值不变 | 吸收 |
| `da866ada1` | 会话上下文在内存中保留；Durable Object SQLite 适配器 | 吸收 |
| `ae92585d3` | 检查保留上下文时上报设置失败 | 吸收 |
| `eb326d265` | codemode 输出条目分离（`==> text N/M <==` 头与 `<console_output>` 块） | 吸收 |
| `ce8972a0e` | 新增 OpenAI Decisions 分类器（`gpt-6-luna`）与分类器图片输入；共享分类器 HTTP 代码移入 `classifier-shared.ts` | 吸收 |
| `6b5854454` | 空的 OpenAI 分类器目录按类型收敛 | 吸收 |
| `2db5e359b` | MCP 管理器保持可响应，启停/重连期间界面不阻塞 | 吸收 |
| `8d8ae2fc2` | Anthropic OAuth 回调端口被占用时回退到空闲端口 | 吸收 |
| `ea6fa125a` | 更新 Nix 模型目录 pin | 跳过，本仓库未保留 `nix/` |
| `b2363841a` | Herdr 终端按支持 OSC 8 超链接识别 | 吸收 |
| `7fb59f995` | Mistral 以 `finish_reason: "error"` 结束的响应改为可重试（错误信息带 `server error`） | 吸收 |
| `b30a6dd77` | 图片压缩的 worker 回复加 `type` 标记，忽略 Node 自己在 worker 通道发的消息（`node --watch` 下图片曾被当作「无法压缩」丢弃） | 吸收 |
| `adae82464` | `docs/providers.md` 记录 azure provider id、Foundry 模型与 deployment 映射 | 吸收 |
| `592fb57b7` | Termux 报告的平台是 `android`，剪贴板读写与 Termux:API 提示按此识别 | 吸收 |
| `27c7b6ff4` | 跨输出块切开的 ANSI 序列在 bash 结果里被剥掉 | 吸收，保留本地 `backgrounded` 提前返回 |
| `f10993bc7` | MCP OAuth 登录可取消，关闭时不再刷新令牌 | 吸收 |
| `503c60552` | 用 OSC 7501 报告程序状态 | 吸收，环境变量记为 `AMAZME_PROGRAM_STATUS` |
| `f76c1db66` | 增加 Claude Haiku 5.5 | 吸收 |
| `943a10e74` | 各模型目录保留按提示长度分档的价格 | 吸收 |
| `dce4ae6f7` | 为 v1.1.0 核对 changelog | 吸收已落地条目；工具增减的当前实现与验证见 `ddaa0a034` 及产品计划，Bedrock OpenAI 推理档继续跟进 |
| `a2eef9eb6` | 固定 Kimi K3 的 Moonshot 价格，并期望 Haiku 5.5 使用自适应思考 | 吸收 |
| `70759f48b` | 处理 npm audit：`shx` 从 0.4.0 降到 0.3.4 | 吸收，`@amazme/gui` 的同一依赖一并降级 |
| `e91631070` | 测试改为等待流和 watcher 事件，不再固定 sleep | 吸收 |
| `bf8d9c659` | 发布脚本可以跳过测试 | 跳过，本仓库没有根 `scripts/release.mjs`，也没有 `.pi/skills` |
| `abe508e1b` | 发布 v1.1.0 | 吸收共享包的版本号和 changelog 分段；`@amazme/web` 与 `@amazme/gui` 仍是 1.0.4 |
| `75a99721d` | 为下一轮补上 `[Unreleased]` | 吸收 |
| `1cedd3272` | `showHardwareCursor` 打开时只使用终端光标 | 吸收，不覆盖 tui 里已有的指针离开和行首行尾改动 |
| `21d1dcd4d` | OAuth 提示回归去除零宽光标标记 | 已覆盖，本仓库原有 `stripTerminalSequences` 同时去除 APC；既有回归通过，无重复修复 |
| `7f9e1198f` | 发布配置 schema，共用默认值/兼容配置/主题 token，修正 Shift 符号按键 | 吸收；补上 AmazMe 的界面设置与自有快捷键。schema 随包发布，使用本地引用；原生/SDK 复用同一默认值，保留 F3 搜索与剪贴板设计 |
| `6b07b4e57` | Mistral 超时只约束响应头 | 吸收，并补齐未传取消信号时仍被超时截断的上游遗漏；实际 HTTP 长流通过 |
| `bd21693b9` | GitHub issue 去重提示模板 | 跳过，Pi 仓库维护提示，本产品未引入对应维护流程 |
| `89e12ccd4` | 批准贡献者 | 跳过，Pi 仓库治理；AmazMe 无对应 `.github` 流程 |
| `7933a0e28` | issue 标签分派维护者及重开 | 跳过，硬编码 Pi 团队维护者，非产品能力 |
| `ce950d78f` | Claude 5.5 使用 models.dev 元数据 | 吸收；删除三个临时模型兜底，重新生成目录并核对既有价格断言 |
| `6fb2e7815` | 支持 npm 12 pack 的对象结果 | 吸收到现有依赖闭包打包器，继续验证实际包身份和文件清单 |
| `f1b2e77f5` | 嵌套 worktree 读取符号链接 AGENTS.md | 吸收，按目录真实路径去重；实际 symlink 布局及既有检查通过 |
| `5a1049269` | 本地 issue triage 服务、维护分类及 UI | 跳过，Pi 维护服务并非运行库；其普通 Durable agent 和结构化结果设计由下项吸收，不另加 HTTP 服务或同步库 |
| `eba849739` | Durable 嵌套调用/结构化结果/调用方/存储失败边界 | 吸收；使用同一 ToolTask 内核及父任务作用域结果，迁移原生 MCP/codemode、插件及 TUI/Web；存储失败收拢到既有宿主清理屏障 |
| `42a3497d0` | 图片读取和可选 Photon 处理器 | 吸收；Photon 子入口显式加载，默认入口不引入 WASM；产品沿用已有图片 worker 和来源大小限制 |
| `f44707e7f` | 按使用期限淘汰 Session 文档缓存 | 吸收；`documentRetentionMs` 默认十分钟，支持立即淘汰；观察中的文档仍保留，原有存储失败边界不变 |
| `cdaf6c227` | Node Photon 图片处理移到 worker | 吸收；显式子入口加载，空闲后回收 WASM，无法启动 worker 时回退当前线程；不改默认图片管线 |
| `e6b9a6af5` | 应用自定义输入条目、展示条目立即追加 | 吸收；TUI/Web 及会话名称、返回点识别应用输入，内部摘要不误判为用户输入 |
| `96abe9a5a` | 配置 schema 改用 pi.dev 地址 | 保留本地差异；AmazMe 的四份 schema 已随包发布，继续使用本地引用，不绑定 Pi 公网 schema |
| `15e7bdc14` | 压缩摘要不传入 thinking | 吸收 SDK 和 Durable 的摘要消息序列化及回归 |
| `89e5c2c07` | 阻塞压缩失败使运行失败，失败持续可见 | 吸收；不再发送超出阈值的模型请求，事件、Durable TUI/Web 持续展示失败，成功压缩后清除 |
| `367b2bcf5` | Env 交互式伪终端 | 吸收 daemon 协议与 `openTerminal`；支持原始字节、输入、窗口缩放、取消及退出码；保留既有前台命令设计 |
| `74613de65` | 查询伪终端前台任务 | 吸收 `ptyForeground`/`terminal.foreground()`；区分 shell 与其前台作业 |
| `2a33bbee8` | Radius 丢失 Claude thinking 重放的 E2E 复现 | 吸收复现用例，不宣称供应商问题已修复；本轮未运行实网用例 |
| `0f4b1465a` | Codex 请求字节复制为独立 ArrayBuffer | 吸收；维持 Pi 的供应商请求身份 |
| `97195ec3c` | 根配置兼容 pi-private、Android APK 及 Biome 包装器 | 跳过；AmazMe 无私有 apps/mobile、APK 发布及 Android Biome 构建流程，不引入无消费者的配置和依赖 |
| `d77d2752e` | schema 工具失败且未给结构化值时向程序提供错误文本 | 吸收；以错误诊断保留文本，已有结构化值及本地输出改写保护不变 |
| `091bcc099` | Chord 数组追加不重复遍历、复制 | 吸收并保留不可变结果、数组编辑顺序及分支冻结契约 |
| `edb2eb966` | 延迟终端回复不进入键盘输入 | 吸收完整及分段 CSI/OSC 回复识别，保留真实用户按键 |
| `cd8bdf751` | 图片转换测试适当放宽 CI 超时 | 吸收；不跳过转换断言 |
| `dbc7ff87c` | 压缩状态组件支持 colorFn 覆盖 | 吸收到 AmazMe 的状态组件，保留现有界面层次和主题 |
| `56cd19431` | 批准贡献者 | 跳过；Pi 仓库治理，AmazMe 无对应审批流程 |
| `0fb1aee74` | Codemode host 驱动的确定性运行 | 吸收 `sandbox.start()`、时钟/随机数/交付顺序控制、运行指纹及取消生命周期；三种运行后端维持一致协议 |
| `78a3c10ba` | herdr 支持 Kitty 图片 | 吸收终端能力识别及回归 |
| `8a9c051f8` | 工具声明呈现 schema 约束 | 吸收枚举、边界、格式等约束，保留声明预算 |
| `7b597d148` | Durable codemode 子入口 | 吸收；确定性重放日志、稳定键嵌套调用、会话 store/fork；沿用 256 次/8 层调用与权限边界 |
| `127b77121` | codemode 结果列出脚本调用 | 吸收调用状态、参数摘要、错误及耗时 |
| `04566631c` | 关闭沙箱不决定脚本结果 | 吸收；重启仍按已提交日志恢复，不把宿主关闭当作脚本取消结果 |
| `8bb180bec` | Durable codemode 工具目录、搜索、输出、models 与 grammar | 吸收；工具可见性按当前 agent 过滤，模型操作走内部嵌套工具，输出截断与落盘不绕过本地限制；入口保持 portable |
| `427052247` | codemode 描述明确 schema 工具失败仍可返回自身值 | 吸收 coding-agent 的工具说明，与 Durable 的错误规则一致 |

此前配置与修复验证：AI 构建及 52 项既有检查、coding-agent 构建及 204 项既有检查、TUI 构建及 60 项按键检查、9 项打包检查和依赖/浏览器入口检查通过。真实 HTTP 长流、4 份 schema 的生成一致性、AmazMe 设置/扩展按键/严格主题及 symlink worktree 已核对；npm 12.2.0 实际打包 14 个依赖包，包含 4 份 schema 且无旧主题校验文件。TUI 原有拖选复制失败已在后续阶段解决：编辑器选区接入共享宿主剪贴板，既有用例核对实际选区与替换行为；全包通过。未新增测试。

此前 Durable 与产品接线验证：Durable 构建、1067 项既有检查通过，6 项失败均在吸收前的隔离源码中复现（事件投影 5 项、缺失定义父任务的清理顺序 1 项）；后续整体验收已修正增量发布并同步既有断言，现为 1073 项通过；3 项跳过。coding-agent 的 72 项接线/生命周期检查、Web 的 120 项检查、9 项打包检查、可选插件类型检查和依赖/浏览器入口检查通过。未新增仓库测试。

此前正式 tarball 的 15 包隔离安装实际验证：50KB 嵌套结构化结果、稳定键重用、父任务结果回收、SQLite 重开、非零退出码；Photon 4000×1000 缩至 2000×500、BMP 转 PNG、JPEG EXIF 转正；非法读取仅拒绝当前调用，致命后端失败关闭会话。安装版 worker 上报故障并退出，插件释放、存储关闭、会话锁释放各一次。安装版宿主通过 stdio/HTTP MCP、资源、codemode、工作流成功/失败、完成验证、自修改与重载；SQLite 69 个任务全部终止。真实 DeepSeek 调用原生插件成功，临时连接和进程已关闭，插件租约释放平衡。

本轮 25 提交验证：Chord、Codemode、Durable、Env、TUI、coding-agent、Web 及桌面壳分别构建后测试通过；Durable 默认保留和立即淘汰两轮各 1318 项通过。AI 离线构建及隔离凭据测试 1305 项通过，实网用例、真实 OAuth 登录和本地模型未跑，Radius E2E 仅同步复现。类型检查、依赖/浏览器入口检查和 25 项工程测试通过。14 个正式 tarball 离线隔离安装通过，安装版实跑了应用输入、确定性 codemode、嵌套调用、会话 store、立即淘汰、Photon 图片 worker、PTY 和 CLI 版本入口。Darwin/Linux 的 arm64/x64 daemon 均已重新构建，源码指纹与二进制校验通过；PTY 在当前 Mac 实跑，Linux 仅交叉构建，未做 Linux 实机运行验收。

## QwenPaw 改进借鉴（非源码基线）

核对本地 QwenPaw 的 `f3895346..2744a976`，共 19 个提交。AmazMe 仍以 Pi 为实现基线；这里只吸收现有消费者需要的行为，不移植 Python/AgentScope、React 展开树或 Hub 管理体系。

| QwenPaw 提交 | 内容 | 处置 |
| --- | --- | --- |
| `616c9cec` | 桌面设置 UI | 等价覆盖；已有自有设置布局与图标 |
| `7147731d` | DST-aware transcript 时区 | 等价覆盖；数值时间戳，自动化使用 IANA 时区和 Temporal |
| `ddd8408e` | HTTP 来源下 terminal UUID | 跳过；Web 限定回环地址，无其非安全来源场景 |
| `46de6b28` | 音频理解工具 | 仅参考；适合作为可选插件，不扩张核心消息协议 |
| `db9eb740` | terminal UUID 修正 | 跳过；空提交，无文件改动 |
| `b85d5a20` | Data UI 宿主类型 | 跳过；源产品专属应用与 SDK |
| `d7a0f50e` | 连接检查携带 session header | 等价覆盖；推理请求已有会话头，无同类连接探测入口 |
| `04b725ac` | 设置页精简重复标题 | 等价覆盖；Codex 对齐阶段已精简导航 |
| `dc744d90` | 媒体载荷拒绝恢复 | 适配吸收；SDK/Durable 在原有重试预算内只做一次请求级无图片降级，保留历史、模型能力、取消与持久重启，并显示诊断；不绕过鉴权、安全或配额 |
| `070d736d` | EXIF 图片方向 | 等价覆盖；SDK/Durable 已处理方向与翻转 |
| `73325aa2` | 本地模型推荐 | 跳过；源产品特有推荐名单 |
| `a211f474` | 技能异步复制和 stage 清理 | 适配吸收；规范路径队列与独占目标保护同名导入，复制失败只清理自身目标，重载失败不撤销已发布技能 |
| `c0e4bc5d` | composer 窄窗换行 | 等价覆盖；现有 composer 支持换行 |
| `6786b4c1` | 空白回复展示过滤 | 适配吸收；分组前跳过纯空白助手文本，保留工具流程、非文本内容和原始消息 |
| `c53afd78` | 复制图标尺寸 | 等价覆盖；自有 SVG 与固定尺寸 |
| `fb308f57` | 目录刷新和分页 | 适配吸收；平面目录每页最多 100 项，刷新与读文件后返回同一目录保留页码，切换目录重置，缩减后收敛；只复制/渲染当前页和读取当前页元数据，不引入展开树缓存 |
| `3b961b76` | Hub 上下文校验 | 跳过；没有对应 Hub 管理界面 |
| `7ec4df9c` | chunk 恢复与启动诊断 | 适配吸收；HTML 入口级轻量错误兜底与手动重载，不复制 React/Vite chunk 体系或自动刷新循环 |
| `2744a976` | Hub 管理员 token 上限覆盖 | 跳过；没有对应 Hub，模型配置已有显式覆盖 |

合计：5 项适配吸收、1 项仅参考、7 项等价覆盖、6 项跳过。目录分页仍需完整枚举名称；只界定元数据读取和复制/渲染的上限，不宣称遍历已变为常量开销。符号链接先与文件分组按名称参与分页，选中页再读取授权目标元数据；目录链接仅在页内按实际类型排序。

验证采用隔离凭据的逐包构建和测试，覆盖技能并发、空白回复、请求级图片降级、启动失败与目录分页；类型、依赖方向和浏览器入口检查通过。Chromium 使用伪入口验证 404/语法错误和手动恢复，并使用隔离 HOME 的真实宿主验证文件分页，不发送模型任务。未进行真实媒体供应商恢复验收。一次未隔离的既有 Codex 缓存 E2E 意外读取本机凭据并进行了实网请求，缓存命中率 `0.899135446685879` 未达到 `0.9`，该结果不计为通过；之后 Durable 的默认保留和立即淘汰两轮离线验证通过。

## 刻意偏离

- 面向供应商的身份字符串维持 pi：运行时请求头（Codex `originator`/`User-Agent`、OpenRouter、opencode client）和登录默认名（ChatGPT `agent_name_hint`、Codex 登录 `originator`）都保持 pi 身份，避免脱离 pi 与供应商的合作关系。`LoginOptions.agentName` 选项保留，调用方需要时可覆盖。
- Durable 保留 256 次/8 层嵌套调用限制、输出改写时丢弃未同步改写的结构化数据、文件读取版本保护和工具选择边界；普通 workflow/verification 父任务登记到同一嵌套索引。v1 在途工具一次性迁移，已执行阶段按不安全重放处理，不另留旧执行器。
- `coding-agent` 与 `tui` 已按 AmazMe 方向重做（Dashboard、子会话、前台命令、编辑器选区等），吸收上游时只取功能，不覆盖界面结构。
- 库包（`agent`、`ai`、`chord`、`durable`、`env`、`mcp`、`protocol`、`server`、`client`、`codemode`、`telemetry`、`evals`）以 Pi 的功能基线同步，AmazMe 的本地扩展按本节保留。本仓库在 `client`/`server` 之上另加了 `websocket` 子路径（回环字节传输，见 `transports/websocket`），并新增了独立的私有包 `@amazme/web`（回环页面的文档与样式、启动契约、视图投影与 DOM 渲染器，浏览器侧入口在 `coding-agent` 的 `host/web`）；吸收上游时不要覆盖这些文件。
- `durable` 的上游改动 `68ccef176`、`b0114ef5f`、`76f6c06da`、`636703a0a` 在 Web 客户端开工前一次性吸收，`runtime.context()` 的 options 对象改动随之落地。本仓库另有通过执行环境运行的搜索工具、持久名称/模式选择、默认不激活注册、加载边界与轻量共用匹配器；上游同步时保留这些实现与回归。

## 跟进方法

1. 在 pi 仓库 `git fetch` 后看新提交：`git log --oneline main..origin/main`。
2. 看提交涉及的包：`git show <提交> --stat`。
3. 库包对比（忽略改名）：
   `diff -r --exclude=node_modules packages/<包>/src <pi 仓库>/packages/<包>/src`
4. 分类处理并在上面的表格记录：吸收 / 只参考 / 跳过（不适用项写具体原因），实施中的改动继续跟进。
5. 吸收后按包的约定验证：`npm run build --workspace <包>`，再 `npm test --workspace <包>`。`coding-agent` 有存量失败，用干净基线对比确认失败集合没有新增。
6. 更新「当前基线」和表格。

安装产物升级核对：v1 在途嵌套工具一次性迁移到 v2，旧副作用未执行，调用标为 interrupted，父任务结束后结果回收。
