# 上游对齐

实现来自 [Pi](https://github.com/earendil-works/pi)。本文件记录当前对齐的上游基线、基线之后已处理的提交、刻意偏离和跟进方法，供后续吸收改进时使用。

## 当前基线

对齐到 pi 提交 `0cf65d2bf`（2026-10-06），包含 v1.0.4 的全部内容。此前已处理到 `1cedd3272`（2026-10-08，发布 v1.1.0）。本轮核对它之后至 `42a3497d0` 的 12 个提交；配置及修复已吸收，Durable 两项继续实施，具体处置见下表。

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
| `ddaa0a034` | `--tools` 接受 `+name`/`-name` 条目 | 吸收 SDK、CLI、设置与重载语义；默认 Durable TUI 共用选择计算并持久化激活及调用边界，补齐提前校验、动态注册、分支恢复和同名扩展回归。原生 MCP 与 codemode 按产品计划继续落实 |
| `56b25ff4e` | 对齐 `docs/message-types.md` | 暂缓，纯文档 |
| `8b5708dbb` | 重试 `server_busy` 瞬时错误 | 吸收 |
| `83c9e2645` | 全屏选区在 transcript 重建时清理 | 吸收 |
| `68ccef176` | durable 复用已扫描的 context 范围 | 吸收 |
| `b0114ef5f` | durable 在 `ToolExecutionApi`/`HookApi` 暴露 `models` | 吸收 |
| `76f6c06da` | durable 可读更早条目的 context | 吸收 |
| `18336987a` | `outputPad` 覆盖所有 transcript 块，`!!` 头部保持 dim | 吸收，`!!` 颜色本仓库已在 `e20383c` 修正，只取 `outputPad` 部分 |
| `27075fe07` | context 估算改为 3.5 字符/token | 吸收 |
| `269121616` | codemode 查找助手在描述里标注 async | 吸收 |
| `311f0e020` | 随估算调整输出上限断言 | 吸收，与 `27075fe07` 同批 |
| `2989eb581` | Bedrock Converse 传 OpenAI 推理档位 | 暂缓，只影响 Bedrock 上的 GPT 模型 |
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
| `eba849739` | Durable 嵌套调用/结构化结果/调用方/存储失败边界 | 实施中，替换现有重叠实现并迁移产品调用方 |
| `42a3497d0` | 图片读取和可选 Photon 处理器 | 实施中，继续保持处理器显式导入 |

本轮配置与修复验证：AI 构建及 52 项既有检查、coding-agent 构建及 204 项既有检查、TUI 构建及 60 项按键检查、9 项打包检查和依赖/浏览器入口检查通过。真实 HTTP 长流、4 份 schema 的生成一致性、AmazMe 设置/扩展按键/严格主题及 symlink worktree 已核对；npm 12.2.0 实际打包 14 个依赖包，包含 4 份 schema 且无旧主题校验文件。TUI 全套的拖选复制既有用例失败，换回改动前按键源码仍失败；本轮未改变相关鼠标实现。未新增测试。

## 刻意偏离

- 面向供应商的身份字符串维持 pi：运行时请求头（Codex `originator`/`User-Agent`、OpenRouter、opencode client）和登录默认名（ChatGPT `agent_name_hint`、Codex 登录 `originator`）都保持 pi 身份，避免脱离 pi 与供应商的合作关系。`LoginOptions.agentName` 选项保留，调用方需要时可覆盖。
- `coding-agent` 与 `tui` 已按 AmazMe 方向重做（Dashboard、子会话、前台命令、编辑器选区等），吸收上游时只取功能，不覆盖界面结构。
- 库包（`agent`、`ai`、`chord`、`durable`、`env`、`mcp`、`protocol`、`server`、`client`、`codemode`、`telemetry`、`evals`）以 Pi 的功能基线同步，AmazMe 的本地扩展按本节保留。本仓库在 `client`/`server` 之上另加了 `websocket` 子路径（回环字节传输，见 `transports/websocket`），并新增了独立的私有包 `@amazme/web`（回环页面的文档与样式、启动契约、视图投影与 DOM 渲染器，浏览器侧入口在 `coding-agent` 的 `experimental/web`）；吸收上游时不要覆盖这些文件。
- `durable` 的上游改动 `68ccef176`、`b0114ef5f`、`76f6c06da`、`636703a0a` 在 Web 客户端开工前一次性吸收，`runtime.context()` 的 options 对象改动随之落地。本仓库另有通过执行环境运行的搜索工具、持久名称/模式选择、默认不激活注册、加载边界与轻量共用匹配器；上游同步时保留这些实现与回归。

## 跟进方法

1. 在 pi 仓库 `git fetch` 后看新提交：`git log --oneline main..origin/main`。
2. 看提交涉及的包：`git show <提交> --stat`。
3. 库包对比（忽略改名）：
   `diff -r --exclude=node_modules packages/<包>/src <pi 仓库>/packages/<包>/src`
4. 分类处理并在上面的表格记录：吸收 / 只参考 / 跳过（不适用项写具体原因），实施中的改动继续跟进。
5. 吸收后按包的约定验证：`npm run build --workspace <包>`，再 `npm test --workspace <包>`。`coding-agent` 有存量失败，用干净基线对比确认失败集合没有新增。
6. 更新「当前基线」和表格。
