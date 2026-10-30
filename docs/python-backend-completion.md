# 当前实现与验证入口

产品版本见 [根清单](../package.json)，执行契约见[本机方案](python-backend-plan.md)，模块职责见[后端架构](../backend/ARCHITECTURE.md)，客户端依赖见[依赖清单](python-backend-ts-deps.md)。这些入口描述当前源码，不沿用迁移阶段的完成声明。

## 当前实现

- Python Host、worker 与监督器拥有账号、模型、会话 SQLite、审批、工具执行和清理。
- Web/Electron、CLI/TUI、RPC 与 Python SDK 共用 Python 契约；TypeScript 保留客户端呈现、终端及 QuickJS helper。
- 执行直接作用于本机；应用层路径限制和审批不是操作系统沙箱。
- MCP、PTY、插件和 Codemode 按会话与调用身份管理；未知副作用不自动重放。
- 桌面关闭窗口和退出应用使用统一生命周期入口；偏好保存在 Python 设置中。

## 开发与验证入口

开发采用 `confident-development-conventions`。先读取实现与调用关系，用类型、状态归属和模块边界保证逻辑闭环；完成与改动相称的必要验收后交付，通过真实反馈迭代。

| 范围 | 入口 |
| --- | --- |
| Python 类型与语法 | `backend/.venv/bin/ruff check backend/src backend/examples/sdk`、`backend/.venv/bin/pyright --project backend/pyproject.toml` |
| Python 模块边界与公开入口 | `backend/tools/check_architecture.py`、`backend/tools/verify_imports.py` |
| 跨端契约 | `backend/tools/export_contracts.py --check` |
| 客户端 | 受影响 workspace 的 build，以及 `npm run typecheck` |
| 模型评测 | `npm run eval`，显式选择模型和凭据 profile |
| 冻结包完整性 | `backend/tools/verify_frozen_resources.py --executable <本轮产物中的 amazme-backend> --report <产物外路径>`；只读检查 manifest、文件摘要和必需资源 |
| 产品自检与诊断 | 模型连接检查、会话诊断、`amazme doctor`；桌面打包的 `--verify` 启动自检 |
| 资源归属与残留 | `backend/tools/resource_census.py` |
| 构建、依赖与开发资产 | `npm run check:workspace` |

行为验收只选择受影响的真实入口，使用独立 profile；按需核对边界输入、取消或失败出口、保存后重开。临时脚本、样本和报告放在系统临时目录或已有忽略目录，完成后清理。相同改动通过必要验收后复用结果，不默认运行完整构建或反复打包。

## 构建与证据范围

安装包的身份来自其 `Contents/Resources/amazme-backend/build.json`。只读完整性校验不能证明客户端交互、真实供应商、OAuth、TCC、SSH、睡眠或断电行为；这些场景按改动需要单独实测。没有本次结果的项目保持未验证。

测试套件、故障注入与迁移阶段的运行报告已从当前树移除，历史报告可从 Git 查询。旧报告、构建路径和完成数字不能证明当前 HEAD 或现有 App 已验证。
