# 上游对齐

实现来自 [Pi](https://github.com/earendil-works/pi)。本文件记录当前对齐的上游基线、基线之后已处理的提交、刻意偏离和跟进方法，供后续吸收改进时使用。

## 当前基线

对齐到 pi 提交 `0cf65d2bf`（2026-10-06），包含 v1.0.4 的全部内容。该基线之后的提交已逐条核对到 pi `636703a0a`（origin/main 顶端，2026-10-07），处置见下表。

基线之后已处理的提交（按 pi 提交顺序）：

| pi 提交 | 说明 | 处理 |
| --- | --- | --- |
| `9f013cf59` | 自更新后清理旧的 managed releases | 吸收 |
| `f6127a1bf` | llama.cpp 原生决策模型（`typesafe-system-one`） | 吸收 |
| `9ad083102` | 登录时可用 `agentName` 自报名 | 吸收，默认身份维持 pi（见下） |
| `1ffb6bd62` | 独立二进制禁用 .env 自动加载 | 吸收 |
| `0cf65d2bf` | Codex `originator`/`User-Agent` 允许被调用方覆盖 | 吸收 |
| `428a12bc7` | 批准贡献者（GitHub Actions bot） | 跳过，仓库治理，AmazMe 无 `.github` |
| `23cf2b948` | 统一 npm 包产物校验，重写发布与本地安装脚本 | 跳过，本仓库未保留根 `scripts/` 发布链；`packages/evals/docker/install-runtime.mjs` 因此仍是悬空引用，待单独决定删除或自包含 |
| `ddaa0a034` | `--tools` 接受 `+name`/`-name` 条目 | 暂缓，是功能不是缺陷，涉及 sdk、settings-manager、agent-session 的语义分支和文档 |
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

## 刻意偏离

- 面向供应商的身份字符串维持 pi：运行时请求头（Codex `originator`/`User-Agent`、OpenRouter、opencode client）和登录默认名（ChatGPT `agent_name_hint`、Codex 登录 `originator`）都保持 pi 身份，避免脱离 pi 与供应商的合作关系。`LoginOptions.agentName` 选项保留，调用方需要时可覆盖。
- `coding-agent` 与 `tui` 已按 AmazMe 方向重做（Dashboard、子会话、前台命令、编辑器选区等），吸收上游时只取功能，不覆盖界面结构。
- 库包（`agent`、`ai`、`chord`、`durable`、`env`、`mcp`、`protocol`、`server`、`client`、`codemode`、`telemetry`、`evals`）与上游逐文件一致，差异应只有改名和品牌路径。本仓库在 `client`/`server` 之上另加了 `websocket` 子路径（回环字节传输，见 `transports/websocket`），并在 `coding-agent` 的 `experimental/web` 组合了 web 入口与额外 listeners；吸收上游时不要覆盖这些文件。
- `durable` 已与上游一致：`68ccef176`、`b0114ef5f`、`76f6c06da`、`636703a0a` 在 Web 客户端开工前一次性吸收，`runtime.context()` 的 options 对象改动随之落地。

## 跟进方法

1. 在 pi 仓库 `git fetch` 后看新提交：`git log --oneline main..origin/main`。
2. 看提交涉及的包：`git show <提交> --stat`。
3. 库包对比（忽略改名）：
   `diff -r --exclude=node_modules packages/<包>/src <pi 仓库>/packages/<包>/src`
4. 分类处理并在上面的表格记录：吸收 / 只参考 / 暂缓 / 跳过（跳过时写原因）。
5. 吸收后按包的约定验证：`npm run build --workspace <包>`，再 `npm test --workspace <包>`。`coding-agent` 有存量失败，用干净基线对比确认失败集合没有新增。
6. 更新「当前基线」和表格。
