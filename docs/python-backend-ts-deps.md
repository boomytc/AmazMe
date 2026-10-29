# 当前客户端与执行依赖

| 所属模块 | 当前职责 |
| --- | --- |
| `backend/src/amazme_backend` | 单个 Python 分发包；按业务所有权划分的 Host、会话、模型、账号、执行与入口适配 |
| `packages/coding-agent` | Python 后端的 CLI/TUI 客户端、媒体处理和启动适配 |
| `packages/tui` | 终端输入、布局与渲染 |
| `packages/web` | Web/Electron 页面、Python HTTP/WS 连接、状态投影与呈现 |
| `packages/gui` | Electron 窗口、后台进程生命周期、桌面更新 |
| `packages/codemode` | Python 监督器使用的 QuickJS helper |
| `packages/evals` | Python SDK/Host 的评测入口 |

这些 TypeScript 包保留现有消费者。业务执行与持久状态由 Python 拥有，不恢复旧 TS 业务内核或增加第二套循环。

Python SDK 的正式入口是 `amazme_backend.sdk.Client`，参数使用 `amazme_backend.contracts`。SDK 的导入闭包只含客户端传输与轻量数据；插件 factory 使用 `amazme_backend.plugin_api`。模型调用由 `agent` 装配 prompt、工具和认证值后进入 `ai`；各客户端复用同一 Host 和真实会话/监督器 IPC。

构建输入由 `scripts/package-artifacts.mjs` 管理。Python 源码、gate、helper、快照及静态资源的定位与冻结清单统一在 `backend/src/amazme_backend/platform/resource_manifest.py`。打包读取同一描述，不依赖源文件原来的目录深度。

`npm run check:workspace` 同时检查 TypeScript 依赖方向、产品版本与 Python [模块清单](../backend/architecture.json)。完整所有权和调用路径见[后端架构](../backend/ARCHITECTURE.md)。
