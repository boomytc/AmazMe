# 当前客户端与执行依赖

| 所属模块 | 当前职责 |
| --- | --- |
| `backend/src/amazme_backend` | Python Host、会话 worker、监督器及模型、存储和工具业务 |
| `packages/coding-agent` | Python 后端的 CLI/TUI 客户端、媒体处理和启动适配 |
| `packages/tui` | 终端输入、布局与渲染 |
| `packages/web` | Web/Electron 页面、Python HTTP/WS 连接、状态投影与呈现 |
| `packages/gui` | Electron 窗口、后台进程生命周期、桌面更新 |
| `packages/codemode` | Python 监督器使用的 QuickJS helper |
| `packages/evals` | Python SDK/Host 的评测入口 |

这些 TypeScript 包仍有当前消费者，不因其源于旧版本而删除。业务执行与持久状态只由 Python 拥有。
Python SDK 的入口为 `amazme_backend.sdk.Client`；插件使用 Python factory。
构建输入由 `scripts/package-artifacts.mjs` 管理，依赖方向及产品版本由 `scripts/check-workspace.mjs` 检查。
