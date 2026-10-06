# 上游对齐

实现来自 [Pi](https://github.com/earendil-works/pi)。本文件记录当前对齐的上游基线、基线之后已处理的提交、刻意偏离和跟进方法，供后续吸收改进时使用。

## 当前基线

对齐到 pi 提交 `0cf65d2bf`（2026-10-06），包含 v1.0.4 的全部内容。

基线之后已处理的提交（按 pi 提交顺序）：

| pi 提交 | 说明 | 处理 |
| --- | --- | --- |
| `9f013cf59` | 自更新后清理旧的 managed releases | 吸收 |
| `f6127a1bf` | llama.cpp 原生决策模型（`typesafe-system-one`） | 吸收 |
| `9ad083102` | 登录时可用 `agentName` 自报名 | 吸收，默认身份维持 pi（见下） |
| `1ffb6bd62` | 独立二进制禁用 .env 自动加载 | 吸收 |
| `0cf65d2bf` | Codex `originator`/`User-Agent` 允许被调用方覆盖 | 吸收 |
| `428a12bc7` | 批准贡献者（GitHub Actions bot） | 跳过，仓库治理，AmazMe 无 `.github` |

## 刻意偏离

- 面向供应商的身份字符串维持 pi：运行时请求头（Codex `originator`/`User-Agent`、OpenRouter、opencode client）和登录默认名（ChatGPT `agent_name_hint`、Codex 登录 `originator`）都保持 pi 身份，避免脱离 pi 与供应商的合作关系。`LoginOptions.agentName` 选项保留，调用方需要时可覆盖。
- `coding-agent` 与 `tui` 已按 AmazMe 方向重做（Dashboard、子会话、前台命令、编辑器选区等），吸收上游时只取功能，不覆盖界面结构。
- 库包（`agent`、`ai`、`chord`、`durable`、`env`、`mcp`、`protocol`、`server`、`client`、`codemode`、`telemetry`、`evals`）与上游逐文件一致，差异应只有改名和品牌路径。

## 跟进方法

1. 在 pi 仓库 `git fetch` 后看新提交：`git log --oneline main..origin/main`。
2. 看提交涉及的包：`git show <提交> --stat`。
3. 库包对比（忽略改名）：
   `diff -r --exclude=node_modules packages/<包>/src <pi 仓库>/packages/<包>/src`
4. 分类处理并在上面的表格记录：吸收 / 只参考 / 跳过（跳过时写原因）。
5. 吸收后按包的约定验证：`npm run build --workspace <包>`，再 `npm test --workspace <包>`。`coding-agent` 有存量失败，用干净基线对比确认失败集合没有新增。
6. 更新「当前基线」和表格。
