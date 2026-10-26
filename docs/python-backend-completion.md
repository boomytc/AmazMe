# 当前实现与验证入口

产品版本见 [根清单](../package.json)，执行契约见[本机方案](python-backend-plan.md)，模块职责见[后端架构](../backend/ARCHITECTURE.md)，客户端依赖见[依赖清单](python-backend-ts-deps.md)。这些入口描述当前源码，不沿用迁移阶段的完成声明。

## 当前实现

- Python Host、worker 与监督器拥有账号、模型、会话 SQLite、审批、工具执行和清理。
- Web/Electron、CLI/TUI、RPC 与 Python SDK 共用 Python 契约；TypeScript 保留客户端呈现、终端及 QuickJS helper。
- 执行直接作用于本机；应用层路径限制和审批不是操作系统沙箱。
- MCP、PTY、插件、Codemode 和计算机操作按会话与调用身份管理；未知副作用不自动重放。
- 桌面关闭窗口和退出应用使用统一生命周期入口；偏好保存在 Python 设置中。

## 验证入口

| 范围 | 入口 |
| --- | --- |
| 后端行为与契约 | `backend/tests/`、`backend/tools/export_contracts.py --check` |
| 客户端 | 对应 workspace 的 build、test、typecheck |
| 桌面 smoke | `npm run test:smoke --workspace @amazme/gui` |
| 本机执行与窗口 | `backend/tools/verify_native.py`、`backend/tools/verify_electron.py` |
| 资源归属与残留 | `backend/tools/resource_census.py` |
| 构建与依赖规则 | `npm run check:workspace`、`npm run test:engineering` |

按改动选择检查，不默认运行完整 build/test 或反复打包。
源码检查、替身测试、真实窗口、供应商登录和安装包分别证明各自范围。没有本次结果的项目保持未验证。

## 构建与报告

安装包的身份来自其 `Contents/Resources/amazme-backend/build.json`；必须与同一次验证报告匹配。
`.artifacts/native/` 和本目录的 `python-backend-native-*.json` 是有日期和范围的历史运行证据，不表示当前 HEAD 或现有 App 已验证。不要从其中的 passed、构建路径或完成数字推断当前状态。
真实供应商、OAuth、TCC、SSH、睡眠和断电等外部条件需要单独实测；旧报告不能替代。
迁移前的 VM、Durable、签名公证实验及阶段台账已从工作树移除，必要时从 Git 历史查询。
