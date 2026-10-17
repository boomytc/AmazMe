# 上游对齐

实现来自 [Pi](https://github.com/earendil-works/pi)。本文件记录当前对齐的上游基线、基线之后已处理的提交、刻意偏离和跟进方法，供后续吸收改进时使用。

## DeepSeek Harness 行为增量

本批次参照本地 DeepSeek Harness 的固定区间 `5badb15009ae1756c3afe0ae0cef1faafc290ccc..571902028a75c64c1d767f4ae5fd099485f0ddf0`（1537 个提交）。按当前 AmazMe 载体吸收行为改进，沿用 Pi/Chord/Durable 的包依赖与持久状态，不合并 DSH 的框架、产品账号或旧接口。具体模块、代表提交、仅参考能力差异和本轮验证见 [增量吸收记录](docs/deepseek-harness-absorption.md)。Pi 的供应商 OAuth 身份继续保持原配置。

## 当前基线

当前已处理到 Pi 的 `origin/main` 提交 `8efd314fa`（2026-10-16），共享包仍是 v1.3.0。本轮逐项核对 `4954d7605..8efd314fa` 的 14 个提交：摘要请求不再自带固定输出上限，压缩阈值可按模型覆盖，Harness 的模型与设置可以是函数，空白工具输出与更多网关失败会按既有规则处理，NVIDIA 默认模型改为 Nemotron 3.5 Super VL，并生成 `models.json` 字段参考。此前已处理 `b06c1f2cf..4954d7605` 的 19 个提交、`00d8d0495..b06c1f2cf` 的 21 个提交、`7d75a0e3e..00d8d0495` 的 17 个提交和 `427052247..7d75a0e3e` 的 42 个提交。Web/GUI 继续独立版本 1.0.4。

历史基线为 `0cf65d2bf`（v1.0.4），随后处理 v1.1.0、至 `42a3497d0` 的 12 个提交，以及 `ea448f454..427052247` 的 25 个提交。历史和本轮的具体处置分别记录如下。

历次已处理的提交（各批次按 pi 提交顺序）：

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

本轮 `427052247..7d75a0e3e`（42 个提交）的处置：

| pi 提交 | 说明 | 处理 |
| --- | --- | --- |
| `ee409a85f` | OpenRouter 按凭据筛选聊天模型及额度、价格 | 吸收 AI 目录接口与 coding-agent 刷新/持久化链路；无缓存才使用内置目录，明确的空结果保持为空，不引入旧目录兼容回退 |
| `d4d53612b` | Anthropic 严格工具限制回退 | 吸收；仅对已识别的请求拒绝将 prefer 降级一次，require、已开始的流和取消行为不变 |
| `7bd01fb92` | 重试网关 upstream provider 错误文案 | 吸收并覆盖两种错误文案 |
| `67996ab75` | MCP structuredContent 接受任意 JSON 值 | 吸收协议、客户端及 SDK/Durable 共用结果接线；保留 null、数组、标量并正确搬移 schema 的局部引用 |
| `da0eadf04` | 取消请求不在鉴权刷新后重发 | 吸收请求结束信号与发送前守卫，共享刷新不被单个请求取消 |
| `24382bedd`、`c661bc574` | Codemode 与 MCP 解耦 | 删除共享 MCP 类型与形状探测；工具自身 schema 描述结果，reachesTools 声明发现范围，SDK/Durable 共用本地模块 |
| `a447ba11f` | 自定义消息启动 before_agent_start | 吸收统一运行准备流程；启动期间忙碌、排队和取消闭合，保留本地图片恢复边界 |
| `f11e50f72` | Codemode 文本连接线性化 | 吸收到 SDK/Durable 输出拼接，避免反复展开增长中的字符串 |
| `148622bc6` | MCP 登录 timeout 覆盖整个登录 | 同步 CLI 帮助 |
| `f4cca2dc2` | MCP 连接不预读资源列表 | 吸收按需读取；原生管理状态报告能力，不保留无意义的旧计数 |
| `014873d7d` | Codemode 显示运行及总耗时 | 与 bash 共用计时逻辑，原生与 SDK 共用渲染器 |
| `b6d505cd1` | 拒绝不在首行的 codemode options | 吸收解析与回归，避免静默忽略执行选项 |
| `6a51a39d4` | 资源设置中的 ~ 路径 | 吸收 glob 与精确匹配两条路径，保留本地资源去重与权限约定 |
| `11f991145` | 浮层未处理的滚轮滚动正文 | 吸收；保留本地拖选与焦点行为 |
| `441f5767c` | 文本 print 模式截断返回非零 | 吸收 stderr 诊断及退出码 |
| `e6fb2581d` | Windows 鉴权锁短暂 EPERM 重试 | 吸收有界重试，取消和其他平台的真实权限失败仍立即生效 |
| `3e477eab5` | 强制 OSC 52 剪贴板 | 吸收为 AMAZME_CLIPBOARD_OSC52；不保留旧产品变量别名 |
| `77332f7a3` | Durable 延迟工具与 tool_search 子入口 | 适配吸收；沿用 exposure 与 tools 激活持久化，不新增重复 deferred 布尔配置；SDK、原生工具和 Durable Codemode 共用排序，发现不越过权限或 callers |
| `eb2fce43d` | 拒绝闭合等待环的等待 | 吸收 live/事务覆盖层与普通拥有任务的图检查；保留背景任务不阻塞父任务的语义 |
| `abfe62928`、`aa499c242`、`b6fda579f`、`55df12bf6` | 有界 listFiles 与平台名称 | 吸收可选环境能力、daemon 操作、LocalExecutionEnv/RemoteExecutionEnv、nodePlatform；缺少能力直接拒绝，无旧 daemon 遍历回退 |
| `de022efd6`、`d6370b72d` | PTY 前台进程与目录取消测试稳定性 | 吸收实际前台命令名称等待、可靠取消与跨架构平台检查 |
| `2ee5c1e56` | 删除旧 Chord 指南与测试 | 删除失效指南、handoff 和内部状态测试依赖；当前文档描述新版 Host 与领域资源 |
| `7472cda0d` | 上游移除实验服务端栈 | 按产品决策保留 Web、桌面、会话服务和插件；所有活动消费者迁移到新版 Chord，公开协议升级为 9、协调协议升级为 4，无旧服务消息兼容路径 |
| `0104fef1e`、`19cb534c3` | Chord Host、契约、资源与原生帧 | 吸收新版核心及测试类型依赖；删除旧 FacetHost、ServiceProvider 和 bundler；产品 ESM 产物由 nodeLoader 加载，资源、状态、取消与重载统一交由 Host |
| `7f022043f`、`cd6b2a555`、`7d75a0e3e` | 关闭链接、macOS 锁路径、完整加载根集合 | 随新版 Chord 吸收；补齐产品通道关闭传播、跨连接身份隔离、状态首次同步、会话代际守卫和重载资源共享 |
| `066ebe4ca`、`6db4070f1` | 当前架构文档 | 同步 Chord 文档，重写 AmazMe 协议、客户端、服务端及插件指南；保留产品消费者的真实接线 |
| `b0ac39687` | 退役 Pi Mobile APK 流程并检查 apps/p2 | 跳过；AmazMe 无对应应用、APK hook 或 GitHub workflow |
| `39badde84` | pi-test.sh 指向真实 CLI 源码 | 等价覆盖；现有 `npm run dev:tui` 已直接运行 coding-agent 的 CLI 源码，不另建重复脚本 |
| `235e8886f` | 忽略 node_modules 符号链接 | 吸收通用忽略规则；本仓库无已跟踪的 node_modules 链接 |
| `0a8cfff4c` | 从 Nix 包移除 Chord 与 esbuild | 跳过；AmazMe 无 Nix 包，保留产品插件构建所需的 esbuild 运行依赖 |
| `0d79b74db`、`06a466935`、`d54794918` | 变更记录审计、v1.2.0 与下一轮 Unreleased | 对齐共享包、内部依赖和示例版本，保留本地产品变更；Web/GUI 继续独立版本 1.0.4。Chord 记录保留上游发布与发布后修复分段。删除无消费者的旧 install-lock 和重复的工作区示例锁文件；示例依赖统一锁定在根锁文件，发布消费者按根锁文件裁剪运行依赖并安装验证后的 tarball |

本轮 Chord 迁移验证：Chord 405、Protocol 138、Client 34、Server 55、GUI 57 项通过，真实 Electron 启动与进程退出 7 项通过；Durable 默认及即时淘汰各 1337 项通过、2 项跳过。coding-agent 全量复核 3155 项通过后，修正压缩任务短暂状态的测试观察方式，Web 全组 41 项复测通过；另有宿主接线 267 项和本地 MCP OAuth 24 项通过。类型、依赖方向、浏览器入口、工程脚本及差异检查通过。未调用真实模型供应商。

v1.2.0 收尾验证：逐包构建后复测，coding-agent 3156、AI 1330、Web 188、GUI 57、evals 61 项通过，Durable 两种保留策略各 1337 项通过，其余依赖包检查通过。修正 evals 遗留的 Pi 提示词判定、包作用域检查和评测入口名称；同一目录检查用于容器启动和回归，不保留旧名称或匹配分支。14 个正式 tarball 按当前锁文件隔离安装，CLI 报告 1.2.0；安装版工具发现、外部原生插件重载/失败回滚/恢复、daemon 版本握手及有界目录取消、Web 资源和会话 worker 的状态同步、重载、挂接/分离/删除与清理通过。实际评测安装目录的有文档/无文档分组和内部依赖文档泄漏拒绝通过。四个 Unix daemon 的版本、架构、源码指纹及 SHA-256 校验通过；本机 macOS arm64 实跑，其余仅交叉构建。未执行完整 Docker 评测或真实模型请求。

此前配置与修复验证：AI 构建及 52 项既有检查、coding-agent 构建及 204 项既有检查、TUI 构建及 60 项按键检查、9 项打包检查和依赖/浏览器入口检查通过。真实 HTTP 长流、4 份 schema 的生成一致性、AmazMe 设置/扩展按键/严格主题及 symlink worktree 已核对；npm 12.2.0 实际打包 14 个依赖包，包含 4 份 schema 且无旧主题校验文件。TUI 原有拖选复制失败已在后续阶段解决：编辑器选区接入共享宿主剪贴板，既有用例核对实际选区与替换行为；全包通过。未新增测试。

此前 Durable 与产品接线验证：Durable 构建、1067 项既有检查通过，6 项失败均在吸收前的隔离源码中复现（事件投影 5 项、缺失定义父任务的清理顺序 1 项）；后续整体验收已修正增量发布并同步既有断言，现为 1073 项通过；3 项跳过。coding-agent 的 72 项接线/生命周期检查、Web 的 120 项检查、9 项打包检查、可选插件类型检查和依赖/浏览器入口检查通过。未新增仓库测试。

此前正式 tarball 的 15 包隔离安装实际验证：50KB 嵌套结构化结果、稳定键重用、父任务结果回收、SQLite 重开、非零退出码；Photon 4000×1000 缩至 2000×500、BMP 转 PNG、JPEG EXIF 转正；非法读取仅拒绝当前调用，致命后端失败关闭会话。安装版 worker 上报故障并退出，插件释放、存储关闭、会话锁释放各一次。安装版宿主通过 stdio/HTTP MCP、资源、codemode、工作流成功/失败、完成验证、自修改与重载；SQLite 69 个任务全部终止。真实 DeepSeek 调用原生插件成功，临时连接和进程已关闭，插件租约释放平衡。

此前 25 提交验证：Chord、Codemode、Durable、Env、TUI、coding-agent、Web 及桌面壳分别构建后测试通过；Durable 默认保留和立即淘汰两轮各 1318 项通过。AI 离线构建及隔离凭据测试 1305 项通过，实网用例、真实 OAuth 登录和本地模型未跑，Radius E2E 仅同步复现。类型检查、依赖/浏览器入口检查和 25 项工程测试通过。14 个正式 tarball 离线隔离安装通过，安装版实跑了应用输入、确定性 codemode、嵌套调用、会话 store、立即淘汰、Photon 图片 worker、PTY 和 CLI 版本入口。Darwin/Linux 的 arm64/x64 daemon 均已重新构建，源码指纹与二进制校验通过；PTY 在当前 Mac 实跑，Linux 仅交叉构建，未做 Linux 实机运行验收。

本轮核对 Pi `7d75a0e3e..00d8d0495` 的 17 个提交（含跟进期间新增的 2 项），分阶段记录：

| pi 提交 | 说明 | 处理 |
| --- | --- | --- |
| `e6220e131` | 测试保留额外 CA 配置 | 等价覆盖；AmazMe 无清空环境的 test.sh，现有 npm/Vitest 入口保留 `NODE_EXTRA_CA_CERTS`；本轮隔离凭据的外部验证助手亦保留该变量，不新增 TLS 设置或重复入口 |
| `90f17f59a` | 线帧声明与校验共用 schema | 吸收 Chord、契约和错误码类型，不再分开维护帧声明和运行校验 |
| `018c87ddc` | 大载荷压缩，relay 不预解压 | 吸收并适配产品 JSON/CBOR 通道，压缩对象保持为线格式，浏览器解压保持 FIFO；新增实际大快照、参数和结果桥接回归，真实浏览器核对 Unicode 及顺序 |
| `a4d040d30` | 子宿主不继承父宿主进程锁 | 吸收；fork 先去掉继承锁，再合并明确配置和子宿主自己的锁 |
| `db6497c3d` | 端到端背压及每链接调用限制 | 吸收 ack、状态合并/重置、发送字节计数和 maxCalls；控制帧与调用结果不被状态阻塞，现有通道保留取消及关闭屏障 |
| `a3a2ee8ec` | 批准贡献者 | 跳过；Pi 仓库治理，AmazMe 无对应 `.github` 流程 |
| `f13c00fb3` | 精确内部依赖版本、版本检查与锁文件 | 吸收全部产品及示例的精确依赖，工作区检查复用现有工程检查入口；运行、开发和可选依赖均校验，保留 peer 与非 registry 引用的语义。沿用根锁文件和现有产物安装器，不恢复旧 install-lock 或另建发布脚本 |
| `746d995b8`、`b9ab2a623` | NVIDIA RTX llama.cpp 配置及前置条件 | 合并吸收最终文档和导航，使用 AmazMe 入口及现有 router 配置；未在此 Mac 上进行 NVIDIA/Windows 实跑 |
| `4b994d5e5` | 修复工具参数中的无效 Unicode 转义 | 吸收；非法转义保留为字面文本，合法 Unicode 和流式截断行为保持正确，后续字段不被丢弃 |
| `cea257439` | 配置会话分享目标 | 吸收 SDK 分享入口、默认值、设置 UI、schema 和文档；显式 Radius 不回退 Gist，显式 Gist 不读取 Radius 凭据。原生/托管客户端无分享入口，不新增上传路径 |
| `34a8bb38b` | Anthropic 错误工具结果不发送图片 | 吸收；只在请求投影中用文本说明替换错误结果图片，成功结果和持久消息保持不变；离线载荷回归通过 |
| `6f2f164ab` | 恢复会话已激活工具 | 吸收 SDK 默认工具恢复及 CLI 修饰符，显式选择不被历史覆盖；无历史声明时保留待注册工具，避免上游改动清空本地延迟激活。Durable 沿用既有持久选择与分支恢复 |
| `3daa20280` | Codemode 取消及时结束并限制 worker | 吸收 worker 真实退出的容量所有权及构造失败回收；SDK/原生共用限制，结果先结束、后台 worker 仍计数，保留本地 execArgv 过滤与嵌套调用边界 |
| `2688aba7d` | 对象/引用命名、variant、协议版本及生命周期 | 吸收并迁移服务所有者、远程视图及 worker；使用 host/referenced 生命周期、Ref 和 codeVersion，移除旧 record 模块。Chord 链接为协议 2，产品握手升为协议 10，旧消费者在握手阶段拒绝，无旧接口实现 |
| `d20c6e966` | 按名称声明、无参数/void 方法和逐状态版本 | 吸收并迁移产品资源所有者、worker fixture 及插件文档，移除旧声明 API；补齐不同 variant 方法参数位置和 void 消费者丢弃返回值的上游遗漏，本地及跨链接回归先失败后通过 |
| `00d8d0495` | 跨宿主重载、任务交接和旧代码回收 | 吸收重载期间子宿主的同步/协调、父子代际退休顺序、先取消旧根再释放资源、任务停止期限、FacetApi.signal、弱引用绑定和取消监听释放；保留资源采纳最新声明。产品组合函数只要求实际使用的 serve/root 能力，不伪造 FacetApi 信号 |

声明 API 阶段验证：Chord 435 项通过（含 4 项先失败的边界回归）；Protocol 139、Client 34、Server 55、Coding Agent 3,173、GUI 57 项通过。逐包先构建再测试，类型及工作区检查通过；Server 沿用上述环境断言的单项排除。

Chord 阶段验证：逐包构建，Chord 425、Protocol 139、Client 34、Web 188、GUI 57、Coding Agent 3,173 项通过；类型、依赖方向、入口预算和浏览器打包通过。大载荷的 JSON 桥接覆盖快照、参数和结果，真实浏览器完成 Unicode 压缩解码及 FIFO 验证。Server 55 项其余测试通过；唯一非回环拨号断言受本机 `utun8` 转发影响，失败可用改动前 `4545f88` 的监听器独立复现，实际绑定仍为 `127.0.0.1`，该项不计为通过。

依赖阶段验证：11 个修改了依赖的产品包逐包构建后测试通过；Server 单独排除上述已复现的环境断言，其余 55 项通过。工程脚本 27 项、类型及工作区检查通过，锁文件仅同步精确版本约束，外部包版本未变。15 个正式 tarball 按根锁文件隔离安装，安装版 CLI 版本及帮助入口通过；大载荷快照、参数和结果经产品 JSON 通道实跑通过。

最终重载及产物验证：Chord 450 项（含代际 GC、跨宿主协调、取消和任务交接）、Protocol 139、Client 34、Server 55、Coding Agent 3,173、GUI 57 项通过；Server 的上述单项环境断言仍排除。类型、工作区、27 项工程检查通过。最终 15 个 tarball 重新隔离安装，CLI 1.2.0 及帮助入口、大载荷 JSON 通道、按名称声明、无参/void 方法、逐状态迁移、任务交接、facet 回滚/关闭和先取消再释放旧资源均通过安装版实跑；产物无旧 record 模块或公开声明入口。17 个提交共 15 项吸收、1 项等价覆盖、1 项仓库治理跳过，逐项已记录。未发送真实模型请求，NVIDIA 文档未作 Windows/GPU 实机验证。

## Pi 后续 21 个提交（2026-10-15）

范围为本地 Pi 已有的远程跟踪提交 `00d8d0495..b06c1f2cf`；核对时 Pi 的 main 停在前者、origin/main 领先 21 个提交。读取该终点的 Git 快照迁移，完成代码吸收后按用户要求将 Pi main 快进到 `b06c1f2cf`，与 origin/main 一致且工作树干净。保留 AmazMe 的产品入口、包作用域、TypeSafe 图像能力及 OAuth/供应商请求身份。

| Pi 提交 | 内容 | 处置 |
| --- | --- | --- |
| `39294a5e9` | IPC 写入失败结束链接 | 吸收发送回调及管理器错误边界，保留产品压缩对象通道 |
| `195120a91` | OpenCode inference 入口 | 吸收生成器、分类器地址与 Go API 组合；保留已实现的 Google 会话头 |
| `60ac3bcc3` | GPT-6 改推理强度保留缓存 | 吸收配置更新、历史强度及 schema；仅为直接 OpenAI 目录启用 |
| `7efebff18` | 网关转发失败重试 | 吸收错误分类 |
| `b04299717` | 有界 base64 转换 | 吸收 btoa 分块及真实堆上限回归 |
| `301617df7` | host 生命周期类型约束 | 吸收类型与运行时约束 |
| `5713c9507` | 压缩后系统基线领头 | 吸收增量/整段投影；条目标识使用 amazme.system，保留原始提交顺序 |
| `47fc5f38e` | GitHub 维护技能入口 | 跳过；指向 Pi 仓库 issue、PR 与收尾提示，非产品运行时能力 |
| `d7f7e0dfe` | 统一模型引用选择 | 吸收 CLI、scope、凭据输出及默认 Durable 入口；内联密钥不自动消歧 |
| `63035734f` | 同块先 thinking 后 text | 吸收 Completions 流顺序与回归 |
| `1692bba63` | Gemini 4 thinkingLevel | 吸收匹配与载荷回归 |
| `6374c2baf` | MiMo 只传思考开关 | 吸收兼容元数据与支持档位 |
| `aa9cf15be` | 状态 init、类型化身份与契约位置 | 吸收并迁移产品服务、插件和 worker fixture |
| `b39979799` | 删除未使用的消息帧 API | 核对无产品消费者后删除源码、测试与导出 |
| `381a2d8eb` | MiMo 重放断言 | 随兼容元数据同步 |
| `5712b134e` | Codex GPT-6.1 Sol 500K 上下文 | 吸收生成器与目录断言 |
| `910149912` | 读取行范围统一呈现 | 吸收 TUI、会话树、HTML 和示例，复用共享格式器 |
| `9fe3f3716` | 保留空引号模板参数 | 吸收解析与位置参数回归 |
| `b45e0ebcc` | 状态就绪与共享引用（协议 4） | 吸收 hydrate、hold/get、binding、状态单位背压、linger 与 variant 类型；产品服务复用同一就绪屏障 |
| `87f9a3641` | 拒绝完成后仍非法的工具 JSON | 吸收所有供应商终结解析、原始诊断与参数校验；SDK/Durable 沿原工具边界拒绝执行 |
| `b06c1f2cf` | Kimi Coding 用 Chat Completions | 吸收模型能力、思考强度和动态工具元数据；OAuth 不改 |

合计：20 项吸收、1 项仓库维护技能跳过。模型生成器重新生成目录与数据，沿用现有生成产物的忽略约定，没有手改生成文件。Chord 保留跨 variant 动态方法参数、void 结果和产品 JSON 压缩桥接修复。

本轮验证：修改包及其产品消费者逐包先构建再测试，没有运行根完整构建或测试。Chord 497、AI 1,384、Agent 91、Protocol 139、Client 34、Web 188、GUI 单元 57、Coding Agent 3,217 项通过；Durable 默认保留和立即淘汰两轮各 1,353 项通过，真实 Electron 生命周期 7 项通过。类型检查、工作区依赖方向、入口预算、浏览器打包、27 项工程测试及 diff 检查通过，构建版 CLI 版本为 1.2.0。删除的消息帧 API 已从源码、导出及本机构建产物中清除，运行时子路径导入确认不可用。

Server 为 55 项通过、1 项既有环境失败：本机非回环接口 `utun8` 能拨通明确绑定 `127.0.0.1` 的端口。本轮用 Node 原生监听独立复现，监听器源码没有修改，该断言不计为通过。最终 AI 验证排除读取默认 OAuth 文件和真实供应商测试，Durable 显式排除 E2E，并清除验证子进程继承的凭据；这些结果不代表真实模型、供应商缓存命中或新接口的实网验收。初次 Durable 验证因 npm 复合脚本只向末轮传递排除参数，误启一次使用本机凭据的 Codex E2E，失败后已终止，不计为通过；随后改为逐轮直接调用 Vitest，完成上述两轮验证。

自审核对 21 项处置、所有 Chord 产品消费者及本地差异。补齐内联密钥歧义在会话存储前拒绝、非法工具 JSON 在钩子和执行前拒绝的回归，并修正目录刷新后 TypeSafe 测试对唯一模型的过时假设；最终无本轮未修正的功能问题。

实现按原子提交记录：`278681c`（Chord 与产品协议）、`dded765`（AI 协议及工具参数）、`60b8d95`（Durable 基线与编码内存）、`09f145b`（模型选择及参数呈现）。本轮没有推送。

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

本轮核对 QwenPaw `2744a976..0547cacf` 的 7 个提交：

| QwenPaw 提交 | 内容 | 处置 |
| --- | --- | --- |
| `02b6a6d0` | 审批决策与超时竞态 | 适配吸收；审批先登记取消监听再发布，结算后释放监听，保留发布期间的早到决策；取消保留所属任务的原因。AmazMe 没有独立审批超时配置，沿用任务取消，不新增另一套超时策略 |
| `74cb6e28` | 活跃结果回收与溢出恢复验证 | 适配吸收；SDK/Durable 共用恢复判据，只有上下文估算缩小且恢复输出预留空间才重试。Durable 在请求钩子之后、发送之前核对，并保存被拒请求的大小，跨延迟响应和重启使用；缺少依据的旧在途恢复直接报告原错误。保留现有有界工具输出、后台压缩与摘要机制，不另建 Scroll 折叠指针；普通输出截断仍沿用 Pi 的一次恢复预算 |
| `878bf453` | Creator 2.0.1 受控媒体生产 | 仅参考；源码是脚本审核、媒体工作流、MiniMax、字幕与模板组成的独立产品，AmazMe 没有相应脚本项目及媒体消费者。本轮不移植 Python/React/FFmpeg 应用或无消费者的阶段和预算配置，也不宣称已有同等 Creator 功能 |
| `753cb6dc` | 生产任务创建后登记运行，删除前停止 | 等价覆盖；Durable 调度器先建立控制器和完成 Promise，再登记运行，执行失败经同一 finally 清理；宿主删除会话先等待 worker 关闭，再删除持久文件和插件。沿用现有任务及资源所有权，不另建 TaskTracker |
| `d4dc9790` | 允许用户中断消息定位滚动 | 等价覆盖；该提交只升级 AgentScope Chat 依赖，AmazMe 没有此依赖。现有 Web 定位使用原生即时滚动，重绘保留选区、焦点和滚动锚点，没有持续抢占用户滚动的动画循环；异步定位核对焦点身份，不引入另一套滚动管理器 |
| `12255f5f` | 保留工具取消原因，单工具失败后继续循环 | 等价覆盖；命令超时保留超时诊断，任务信号取消传播所属原因，单工具取消作为工具结果让父循环继续；宿主关闭和父任务取消仍停止其拥有的工作。真实本地命令超时和单工具取消已验证，无错误的“用户中断”标签，不新增另一套取消原因枚举 |
| `0547cacf` | staging 路径构造前清理技能名称 | 等价覆盖；SkillsService 在拼接目标路径及任何目录写入前校验名称，只接受不超过 64 字符的小写字母、数字与单连字符。import/write 均在验证后才创建独占目标，失败只清理自身目录；没有用原始名称构造 staging 的路径。7 个恶意名称在两种入口均被写入前拒绝 |

合计：2 项适配吸收、4 项等价覆盖、1 项仅参考。恢复空间使用当前消息估算，不能证明供应商实际 token 数；本轮使用隔离凭据、伪模型和真实本地执行环境验证，不发送真实供应商请求。Creator 的媒体生成与新增浏览器交互验收不在本轮范围。

验证：修改包先构建再测试。AI 使用离线目录构建，1,330 项通过；Durable 默认保留与立即淘汰两轮各 1,342 项通过；Coding Agent 最终以 4 个 worker 运行，3,160 项通过。真实供应商用例未启用，三个读取 OAuth 的测试文件显式排除；其余跳过项保留测试自身条件。初次高并发运行出现 Web 重启/关闭超时，单独重跑其 41 项及最终完整包测试均通过。类型检查、依赖方向、入口预算、浏览器打包与 diff 检查通过。审批竞态、无效摘要和预留空间、请求钩子放大、延迟响应及 SQLite 重启均有回归；本地技能路径、命令超时和单工具取消另经真实执行环境核对。

本轮已逐项核对 QwenPaw `0547cacf..f0b38a6a` 的 11 个提交，处置如下：

| QwenPaw 提交 | 内容 | 处置 |
| --- | --- | --- |
| `ed735b48` | 关闭工具流时不在 GeneratorExit 中继续 yield | 等价覆盖；AmazMe 工具执行使用 Promise 和进度回调，终态在执行及清理结算后提交，取消保存已持久输出并关闭进度入口；没有 Python 工具生成器的 finally-yield 路径，沿用现有取消屏障和终态回归 |
| `c6f858f7` | Langfuse 工具 span 保存有界终态输出 | 仅参考；当前没有 Langfuse 工具 span 中间件或消费者。Durable 已保存有界输出、诊断和工具终态，但不宣称已有同等 Langfuse 集成，不新增外部遥测上传 |
| `debcb484` | Hub 技能市场迁为插件，协调加载/卸载请求 | 仅参考；AmazMe 没有这些 Hub 市场及其前后端注册接口，原生插件的注册、调用和卸载由现有 Chord 资源/根调用生命周期管理，不移植市场注册表或旧 URL 兼容路由 |
| `d81427ae` | Console UI/UX 基础、语义页面与轮询调度 | 等价覆盖；Web 使用统一 PanelSpec、局部化 h1、面板/会话文档标题和审批提示，目录及审批由服务订阅更新；可选服务先核对 catalogue，不引入 React PageShell 的 compat 模式、另一个模块注册表或后台轮询 |
| `b40d1a4c` | AgentScope 2.0.10 及使用量流暴露 transport response | 等价覆盖响应访问；现有 OpenAI Responses 入口通过 withResponse 同时取得流和 HTTP 响应，调用 onResponse 并统计最终 usage。AmazMe 无 Python AgentScope 依赖，不同步该依赖版本 |
| `1dc281f7` | 过滤历史媒体前解析实际模型能力 | 等价覆盖；ModelRuntime 先组合模型目录和显式 input 覆盖，未覆盖项保留原能力；Durable 每次请求重新取得实际模型，API 投影据其 input 过滤图片，保留原始历史。不引入另一套三态多模态字段或 formatter |
| `4c20b62a` | 限制后台轮询并解除模型选择阻塞 | 适配吸收到现有模型服务：并发刷新共享一个任务，保留已发布目录，异常恢复为可重试状态；单个读者取消不打断其他读者，服务关闭取消并等待刷新且拒绝迟到发布。Web 的目录、审批、会话列表已使用订阅，没有重复轮询；模型选择本来就不因目录刷新而禁用。删除 ModelRuntime 对旧刷新返回值的兼容分支 |
| `5a5d807b` | SQLite 持久化、备份与恢复加固 | 适配吸收当前 schema 重开不争用写锁，以及写入前拒绝新版/缺失元数据；真正迁移仍在锁内复核并原子回滚。现有 BEGIN IMMEDIATE、启动前配置的锁等待、提交后发布和 worker 独占存储已覆盖。备份/恢复仅参考：AmazMe 没有整库压缩包备份入口，不新增另一套历史库、旧 schema 修补或文件复制恢复路径 |
| `cca13e0a` | chunk 失败后探测服务就绪并重置自动刷新预算 | 仅参考；本轮主要修复 React/Vite 自动刷新预算和就绪探测。AmazMe 为单一预编译入口，已有入口级失败提示与手动重试，连接重建串行退避；没有自动页面刷新预算，也不新增页面后台探测和兼容旧预算格式 |
| `3b9a2b30` | 更新 QwenPaw 开发者会议博客 | 跳过；源产品社区资料，不是 AmazMe 产品或运行时能力 |
| `f0b38a6a` | 版本升为 2.2.2b5 | 跳过；QwenPaw 自有版本。AmazMe 共享包继续按 Pi 的 1.2.0，Web/GUI 保留独立版本 |

模型阶段验证：Coding Agent 最终构建后全包 3,177 项通过，含 4 项刷新回归，覆盖共享请求、独立取消、失败重试、关闭等待及状态观察者同步关闭。测试隔离用户凭据和实网用例。

SQLite 阶段验证：3 项新增用例在旧实现失败，修正后 Durable 默认保留与立即淘汰两轮各 1,345 项通过，Node/Cloudflare facade 和迁移专组 47 项通过；类型与工作区检查通过。使用真实临时 SQLite 文件及同时打开的连接，核对读写锁竞争、元数据拒绝和既有迁移回滚，不操作用户会话库。

最终核对：2 项适配吸收、4 项等价覆盖、3 项仅参考、2 项跳过，完整覆盖上述 11 个提交。Web、GUI 逐包构建后分别 188、57 项通过；类型、工作区依赖与浏览器入口检查、27 项工程测试通过。15 个运行包打包并在隔离目录按锁文件安装通过，安装后的 CLI 版本/帮助、SQLite 写锁下重开与新版 schema 拒绝、模型 input 覆盖与保留原始历史的媒体投影均验证通过。本轮未启用真实供应商请求，也未新增 Hub 市场、Langfuse、整库备份或自动页面刷新能力；不将参考项记为已实现。

本轮核对 QwenPaw `f0b38a6a..4e7b37a9` 的 3 个提交（2026-10-15）。核对时本地 main 位于前者、origin/main 领先 3 个提交，直接读取远程跟踪提交的补丁与源码，不将本地旧工作树当作新实现。

| QwenPaw 提交 | 内容 | 处置 |
| --- | --- | --- |
| `85825a7c` | E2E 对齐当前控制台的菜单、固定状态和页面标题 | 仅参考具体测试适配；AmazMe 的 Web 会话菜单使用稳定的 `data-action` 与 `role="menuitem"`，已有动作、菜单关闭、焦点、归档/恢复及页面标题的直接断言。该提交的 Python PageObject、React CSS 选择器及 Pin/Unpin、统计、备份页面属于 QwenPaw 控制台 |
| `f64299c8` | 外部历史数据库路径与可迁移备份 | 路径等价覆盖；原生 `selectSession()` 按规范化工作目录解析自定义根，支持绝对路径、父级相对路径、`~` 和符号链接，再在指定根下创建分组会话及 `session.sqlite`；Node SQLite 入口也接受外部文件路径。备份仅参考：AmazMe 没有整库 ZIP 备份/恢复入口，不新增归档配置改写、数据库文件复制或 QwenPaw Scroll 历史库；现有 JSONL 会话互通不等同于整库备份 |
| `4e7b37a9` | 版本升为 2.2.2b6 | 跳过；QwenPaw 自有发布版本，不改 AmazMe 的 Pi 共享包版本及独立 Web/GUI 版本 |

验证：Web 和 Coding Agent 分别构建后，Web 全包 188 项、Coding Agent 的原生启动、宿主目录、CLI 参数和 JSONL 互通 43 项通过。另使用当前构建产物与临时目录，实跑 4 种自定义根：通过伪模型保存历史，关闭后从真实绝对根恢复同一会话和数据库，并确认锁已释放、没有回落到默认会话库；独立外部 SQLite 文件也完成父目录创建、写入和重开读取。全程隔离凭据并禁止实网请求，没有操作用户会话库。

自审逐项核对补丁、现有消费者与历史处置，未发现本轮需要修正的运行时代码；因此只更新本跟进记录，不将参考项记为新增能力。本机实际验证为 macOS 路径和 Node SQLite，Web DOM 用例使用 happy-dom；未作 Windows、真实浏览器或整库备份/恢复验收。没有运行根完整构建或测试。

## Pi 后续 19 个提交（2026-10-16）

范围为 `b06c1f2cf..4954d7605`（核对时本地 Pi 停在前者、origin/main 领先 19 个提交）。读取该终点的 Git 快照迁移，完成代码吸收后按用户要求将 Pi main 快进到 `4954d7605`，与 origin/main 一致且工作树干净。保留 AmazMe 的产品入口、包作用域、TypeSafe 图像能力及 OAuth/供应商请求身份。

| Pi 提交 | 内容 | 处置 |
| --- | --- | --- |
| `9a3ca68bd` | 远程引用拒绝外来 ctx | 吸收；远程引用与本地引用一样校验 ctx 的来源、过期与中止，非 Chord 构造的 ctx 直接 `invalid/foreign_ctx`，回归先失败后通过 |
| `550f1f3ec` | 重试 service unavailable 文案 | 吸收错误分类与回归 |
| `dc939913f` | Claude Haiku 5.5 与 Opus 5 支持 off 思考档 | 吸收；生成器只为接受禁用思考的模型保留 `off`，`off` 只发 `thinking: {type: "disabled"}`，不发 effort 标记与 block_binding，目录重新生成 |
| `4a5d37291` | OutputBuffer 与 Progress 移入 chord/output | 吸收；新增 `@amazme/chord/output` 子路径，durable 改为从 chord 导入，测试随模块迁移，补齐 tsconfig、vitest 解析与打包外部清单 |
| `6a1f799b6` | 回退 kimi-coding 切换 | 已覆盖净效果为零；本仓库已在前一批次吸收该切换，回退与再次落地相互抵消 |
| `f7e3cb543` | SQLite 存储支持表名前缀 | 吸收；迁移与查询由同一 schema 映射渲染，前缀在创建数据库前校验，Cloudflare 适配器按存储对象共享操作队列；保留本地已初始化存储只读重开与锁内复核版本 |
| `568c2a82a` | OpenRouter 测试改用 claude-sonnet-4.5 | 吸收测试模型引用 |
| `dfb03c328` | 模型注册表测试同步 | 吸收测试模型引用 |
| `a3f265b1c` | kimi-coding 再次使用 Chat Completions | 已覆盖净效果为零；产品目录在上一批次已按 Chat Completions 生成，`MINIMUM_PI_VERSION` 属于上游目录发布流程，本仓库没有该流程 |
| `eddebaeeb` | Nix 包装器追加 Node 到 PATH | 跳过；本仓库未保留 `nix/` |
| `5ab7fe74c` | 保留错误工具结果的图片 | 吸收；Anthropic 与 Bedrock Claude 用占位替换错误结果里的图片，再把图片放在该轮全部工具结果之后并注明工具调用，持久消息与成功结果不变 |
| `911309429` | 跨模型不再把思考当文本 | 吸收；只有同一模型保留思考块，签名与加密推理仍用于重放，文本与工具调用照旧 |
| `d05a73fb3` | 保持 Nix 模型目录 pin 可构建 | 跳过；本仓库没有 `nix/`、发布脚本与 GitHub workflow |
| `a4f67eb65` | 关闭自己的自定义浮层 | 吸收；`done()` 通过自身句柄隐藏浮层而不是最上层，回归先失败后通过 |
| `2cb2cfa79` | 发布前变更记录审计 | 吸收条目，按本地记录改写 |
| `9800c96ff` | 浮层修复的变更记录 | 吸收条目 |
| `71023aec1` | 发布 v1.3.0 | 吸收版本与内部依赖对齐；共享包与插件、示例随发，Web/GUI 保留独立版本 |
| `ae7b16d43` | 下一轮 Unreleased | 吸收分段 |
| `4954d7605` | 发布前校验目录与已发布版本兼容 | 跳过；本仓库不发布独立模型目录，也没有 GitHub workflow |

合计：14 项吸收、2 项净效果为零、3 项跳过（均与 Nix 或上游目录发布流程有关）。

本轮另有两次目录与本地状态修正，计入同一批次：models.dev 将 MiMo 2.5 线标为弃用后，目录刷新使 Xiaomi 的默认模型与若干测试引用失效，默认模型与测试引用统一移到 2.6 线（`mimo-v2.6-pro`），弃用清单加入 2.5；`experimental-client-tui` 夹具补上此前遗漏的 `suggestPrompt`，使工作区类型检查重新通过。两处都不是这 19 个提交引入的行为。

本轮验证：修改包及其产品消费者逐包先构建再测试，没有运行根完整构建或测试。Chord 522、AI 1,426（隔离 HOME、排除实网 e2e）、Coding Agent 3,298、Durable 默认保留和立即淘汰两轮各 1,341（排除 e2e）、Agent 91、Codemode 229、MCP 45、Env 121、TUI 1,069、Telemetry 15、Protocol 139、Client 34、Server 57、Web 250、GUI 单元 60、Evals 61 项通过。类型检查、工作区依赖方向、入口预算、浏览器打包、模型数据校验及 27 项工程测试通过，构建版 CLI 报告 1.3.0。新回归覆盖外来 ctx、浮层归属、SQLite 前缀与错误工具结果图片。最初一次 Durable 验证未排除实网 E2E，读取本机凭据并误启 Codex 缓存用例，重试后以 `Unexpected submission status: unanswered` 失败，不计为通过；随后显式排除 E2E，完成上述两轮离线验证。不能据最终离线结果将本批次描述为“未发送真实模型请求”。未做 Nix 与上游目录发布流程验收。

### 复核修正（2026-10-16）

- 加载中调用先按契约声明识别 ctx 位置，校验后才等待 hydration 或启动新 root；覆盖伪造 ctx、外来 holder 和已经结算的 holder。同宿主与跨链接路径共用校验，不按 `rootId`/`signal` 字段猜测普通对象参数，也保留跨 variant 的动态参数位置及 holder 取消语义。新增 12 项回归，其中旧实现的 6 项拒绝时机断言先失败，修正后 Chord 全包 534 项通过。
- 四个 Unix daemon 已使用 Rust 1.96.0 和 locked 依赖实际重编译为 1.3.0，架构、源码指纹及 SHA-256 全部通过既有检查。macOS x64 和两个 Linux musl 目标为本机交叉构建；实际运行验收仅为 macOS arm64。`bin/` 继续遵循生成产物忽略约定，不将修改版本元数据当作重建。
- 普通 `npm pack --workspace @amazme/env` 执行 prepack 成功。清理 Durable 的已删除模块遗留编译文件后，14 个运行包按根锁文件打包并隔离安装；安装版 CLI 1.3.0、daemon 协议 1/版本 1.3.0 握手、四个 daemon 的校验和、`chord/output` 子路径及就绪前拒绝无效 ctx 均通过。
- 修正阶段第一次 Durable 复测再次触发复合 npm 脚本的参数转发陷阱：末尾的 `--exclude` 只作用于第二轮，首轮仍误启带本机凭据的 Codex E2E 并以 `unanswered` 失败。进程已结束，不计为通过。随后用隔离 HOME、仅保留 PATH/临时目录/额外 CA 等必要环境变量，并逐轮直接调用 Vitest 显式排除 E2E，默认保留和立即淘汰两轮各 1,341 项通过。此处如实保留两次误启记录，不再以最终离线通过掩盖此前的实网尝试。
- Coding Agent 构建后在同样的隔离环境中全包 3,298 项通过；Env 使用刚重建的 macOS arm64 release daemon，构建后 121 项通过。类型检查、工作区依赖与浏览器入口检查、27 项工程测试及 diff 检查通过。没有进行 Linux/Intel Mac 实机或真实模型成功调用验收。

## Pi 后续 14 个提交（2026-10-17）

范围为 `4954d7605..8efd314fa`（核对时本地 Pi 停在前者、origin/main 领先 14 个提交）。读取该终点的补丁，按文件合并到 AmazMe，不覆盖本地产品差异。供应商 OAuth 身份、`AMAZME_CACHE_RETENTION`、models.json 解析失败时的固定「malformed JSON」文案、Durable 的 `projectContext` 钩子，以及溢出恢复必须带有请求 token 数的守卫都保留。`models.md` 仍写托管模型服务的刷新方式，不改回上游的 `/model` 重载句。

| Pi 提交 | 内容 | 处置 |
| --- | --- | --- |
| `6085986e4` | `ToolControl.terminate` 为 boolean，并回归 `false` | 与 `790271cd0` 一起吸收净效果；`false` 不结束运行，条目种类保持 `amazme.assistant` |
| `c4cf7957b` | `compaction.modelOverrides` 按模型覆盖阈值 | 吸收；阈值检查、溢出恢复和压缩选区使用该模型的条目。本地溢出余量检查同样改用该模型的 `reserveTokens` |
| `790271cd0` | 恢复被上一提交冲掉的 terminate 类型与回归 | 吸收，见 `6085986e4` |
| `0fbdbd3f8` | 重试 node-fetch 的 `request to ... failed` | 吸收错误分类与回归 |
| `99fe14897` | Xiaomi 测试改用 MiMo 2.6 | 已覆盖；上一轮目录刷新已把测试和默认模型改到 `mimo-v2.6-pro`，并额外把 2.5 列入弃用 |
| `90d863f7c` | Xiaomi 默认模型改为 `mimo-v2.6-pro` | 已覆盖，同上一行 |
| `6fcb48670` | 摘要请求不再设置固定 `maxTokens` | 吸收 coding-agent 的会话摘要与分支摘要请求；`reserveTokens` 仍决定何时压缩，以及分支摘要纳入多少上下文。Durable 自己的摘要仍按该模型解析后的 `0.8 * reserveTokens` 封顶，与上游 Durable 一致 |
| `4dd2b149d` | 只含空白的工具输出视为空 | 吸收 OpenAI Completions、OpenAI Responses 与 Google 的占位规则及回归 |
| `698a2d23b` | 重试更多网关上游失败文案 | 吸收 `upstream_error`、`upstream_stream_read_error`、中断流和 HTTP/2 流失败 |
| `7ec1f648e` | `HarnessOptions.models` 与 `settings` 可为函数 | 吸收；生成、压缩、钩子和工具在每次使用时读取当前值。普通对象仍然可用 |
| `2331785c3` | Codex 提示缓存 E2E 改用 `gpt-6.1-sol` | 吸收测试模型。本轮第一次 Durable 全量误跑了该实网用例并通过，见下方验证，不重复执行 |
| `14ff455a0` | read/bash 差异测试提供 `retainedOutput` 并拆开标准输出与标准错误 | 吸收；bash 用例必须返回结果，不能靠两边同样抛错通过 |
| `95364a54e` | NVIDIA 默认模型改为 Nemotron 3.5 Super VL | 吸收解析器默认值和离线可跳过的 NVIDIA 用例模型。变更记在未发布段，不改写已发布的 1.3.0 记录 |
| `8efd314fa` | 从 schema 生成 models.json 字段参考 | 吸收生成脚本、导航和参考页。schema 的 `$id` 仍是随包发布的 `models.schema.json`，参考页不指向 pi.dev |

合计：12 项吸收、2 项已覆盖。没有跳过的产品行为。

本轮验证：修改包先构建再测试，没有运行根完整构建或测试。AI 在隔离 HOME 且去掉继承凭据后 1,432 项通过、863 项跳过。Durable 默认保留的第一次全量是 1,350 项通过、3 项跳过，其中包含一次误启的 Codex 提示缓存 E2E：npm 只把文件参数传给复合脚本的后半段，前半段跑了全部测试，该用例在 `gpt-6.1-sol` 上通过，不再重复。立即淘汰一轮显式排除 E2E，1,349 项通过、2 项跳过。Env 121 项通过、2 项跳过。Coding Agent 在隔离 HOME 下 3,296 项通过、50 项跳过。新回归覆盖空白工具输出、网关与 node-fetch 重试、按模型压缩、函数式模型与设置、`terminate: false`、摘要不再自带输出上限，以及生成的参考页与提交内容一致。未做 Windows 验收。

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

离线验证须同时隔离 HOME 和移除继承的供应商凭据环境变量，保留必要的 PATH、临时目录及 `NODE_EXTRA_CA_CERTS`。Durable 的 `test` 是两轮 Vitest 的复合脚本，末尾追加 `--exclude` 只会作用于后一轮；需要排除实网 E2E 时，必须在隔离环境中逐轮直接调用 Vitest，并在两轮分别指定排除参数，不能只依赖 npm 的尾部参数。

安装产物升级核对：v1 在途嵌套工具一次性迁移到 v2，旧副作用未执行，调用标为 interrupted，父任务结束后结果回收。
