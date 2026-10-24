# 旧 TS 业务消费者

当前契约见 [方案](python-backend-plan.md)，状态见 [任务表](python-backend-completion.md)。
本表记录实际消费者；历史 VM、签名、公证和旧包数字已从当前依赖清单移除，历史证据仍保存在原报告及 Git 历史中。

| 范围 | 当前调用链 | 处置 |
| --- | --- | --- |
| Python 内核 | Host、worker、监督器，本机 shell/PTY/stdio MCP | 不导入 TS，不启动旧 coding-agent 业务运行时 |
| CLI 与 TUI | `cli.ts` / `main.ts` → Python Host、Python CLI；TS 保留输入、终端呈现与文件媒体处理 | 产品入口已迁移；旧 Durable 开关不选择执行后端 |
| 账号、模型与导入导出命令 | `python-product.ts` → `amazme-backend client` → Python SDK/Host | 复用私有账号库与新格式导入导出；不读取旧 auth/settings/JSONL |
| Electron / Web | `gui/main.ts` → 包内 Python，Python Web 页面 | 桌面闭包不包含 coding-agent；缺包内后端时明确失败 |
| 受控 JS helper | Codemode 的 QuickJS、现有终端/媒体处理及打包辅助 | 有实际用途，保留 |
| 旧 Host 与 session-worker | coding-agent 的包导出、构建入口、旧测试，以及旧插件侧的注册依赖 | 仍需迁移消费者并删除；不能据 CLI 迁移宣称整个 TS 内核已删除 |
| `durable/sdk.ts` | 包根导出及 eval 类型消费者，函数目前拒绝旧会话 | 迁移 eval 后删除拒绝占位和旧导出，不保留兼容运行时 |
| evals | 旧 harness、配置与容器工具，运行入口拒绝旧会话 | 改为本机 Python SDK 路线；不恢复 Docker 作为产品执行后端 |
| 原生插件 | 旧 facet 注册；CUA App 配方和原生驱动仍有用途 | 按插件实际产品能力迁入 Python，保留原生配方/必要 JS helper |
| `@amazme/web` / `@amazme/durable` 的页面值导入 | Electron 呈现依赖 | 沿实际导入清理，不能机械删除整个包 |

CLI 单元已删除没有产品消费者的 `cli/auth-check.ts`、`credential-print.ts`、
`provider-auth.ts`、`list-models.ts`、`setup.ts` 和对应旧认证测试。
旧 Host、旧 SDK 和 eval 的拒绝占位仍是未完成项，不能算迁移完成。

构建身份以最终候选包的 `build.json` 及同次生成报告为准，本清单不复制“当前 build_id”。
