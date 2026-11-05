# 当前客户端与执行依赖

| 所属模块 | 当前职责 |
| --- | --- |
| `backend/src/amazme_backend` | 个人本机运行的 Python 后端源码；按业务所有权划分的 Host、会话、模型、账号、执行与入口适配 |
| `packages/web` | React Web/Electron 页面、Python HTTP/WS 连接、按窗口拥有的命令与缓存投影 |
| `packages/gui` | Electron 窗口、共享 Host 连接、显式停服 |
| `packages/codemode` | Python 监督器使用的 QuickJS helper |
| `packages/evals` | Python SDK/Host 的评测入口 |

Web 的 React 挂载不拥有业务连接或持久状态；`PageRuntime` 与功能状态模块拥有页面生命周期，组件只订阅缓存并报告用户命令。Electron 主进程使用 Web 的 `locale`、`strings` 和 `errors` 轻量子入口，不加载 React 渲染器。

Web 启动脚本直接调用 Python 的 `web` 命令；桌面通过 Python 的 `connect` 获得连接。TypeScript 不再维护终端客户端或 stdio RPC 呈现。业务执行与持久状态由 Python 拥有，不恢复旧 TS 业务内核或增加第二套循环。

Python SDK 的正式入口是 `amazme_backend.sdk.Client`，参数使用 `amazme_backend.contracts`。SDK 的导入闭包只含客户端传输与轻量数据；插件 factory 使用 `amazme_backend.plugin_api`。模型调用由 `agent` 装配 prompt、工具和认证值后进入 `ai`；各客户端复用同一 Host 和真实会话/监督器 IPC。

workspace 依赖闭包由 `scripts/workspace-packages.mjs` 管理。Python 源码、gate、helper、快照及静态资源的定位统一在 `backend/src/amazme_backend/platform/resource_manifest.py`。启动脚本编译所需依赖后直接运行本机 Python 与 Electron，不生成安装包。

`npm run check:workspace` 同时检查 TypeScript 依赖方向、产品版本与 Python [模块清单](../backend/architecture.json)。完整所有权和调用路径见[后端架构](../backend/ARCHITECTURE.md)。
