# 旧 TS 业务消费者

当前契约见 [方案](python-backend-plan.md)，状态见 [任务表](python-backend-completion.md)。
本表记录实际消费者；历史 VM、签名、公证和旧包数字已从当前依赖清单移除，历史证据仍保存在原报告及 Git 历史中。

| 范围 | 当前调用链 | 处置 |
| --- | --- | --- |
| Python 内核 | Host、worker、监督器，本机 shell/PTY/stdio MCP | 不导入 TS，不启动旧 coding-agent 业务运行时 |
| CLI 与 TUI | `cli.ts` / `main.ts` → Python Host、Python CLI；TS 保留输入、终端呈现与文件媒体处理 | 产品入口已迁移；旧 Durable 开关不选择执行后端 |
| 账号、模型与导入导出命令 | `python-product.ts` → `amazme-backend client` → Python SDK/Host | 复用私有账号库与新格式导入导出；不读取旧 auth/settings/JSONL |
| Electron / Web | `gui/main.ts` → 包内 Python，Python Web 页面 | 桌面闭包不包含 coding-agent；缺包内后端时明确失败 |
| 受控 JS helper | Python `codemode_helper.mjs` → `@amazme/codemode` 的 QuickJS 沙箱；其余现有终端/媒体处理及打包辅助 | 有实际用途，保留；helper 不执行 TS 业务宿主 |
| 旧 Host 与 session-worker | Python 已接管；Node 只保留 HTTP 客户端与终端输入/呈现 | 旧 Host/Durable/services/facets、公开导出与旧业务测试已删除；bundle 输入检查拒绝再次带入 |
| 会话 SDK | `amazme_backend.sdk.Client`；Python 示例与 eval | 旧 Durable SDK、包根/子路径导出、拒绝占位及失效示例已删除 |
| evals | Vitest → `run_eval.py` → 现有 Python SDK/Host | 真实 Python 插件与供应商配置；删除 Docker、旧模型/扩展宿主消费者及三个内部 JS 依赖 |
| 原生插件 | Python factory；CUA 构建/安装/清理脚本使用原清单 helper | 旧 TS 动作/分类/facet 已删除；保留固定原生配方、安装完整性校验与权限 App helper |
| `@amazme/web` / `@amazme/durable` 的页面值导入 | Electron 呈现依赖 | 沿实际导入清理，不能机械删除整个包 |

CLI 单元已删除没有产品消费者的 `cli/auth-check.ts`、`credential-print.ts`、
`provider-auth.ts`、`list-models.ts`、`setup.ts` 和对应旧认证测试。
Node 包的旧 Host、session-worker 和业务导出已经删除。独立库与 Electron 的页面/文案依赖仍需沿实际消费者收敛，CLI 恢复和资源选项也不能据此宣称全部闭环。

构建身份以最终候选包的 `build.json` 及同次生成报告为准，本清单不复制“当前 build_id”。
