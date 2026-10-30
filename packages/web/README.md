# @amazme/web

Web 和 Electron 共用的原客户端呈现：导航、聊天、模型连接、管理面板和会话停靠栏。会话、账号与执行状态归 Python Host 所有；本包保留草稿、界面偏好和按宿主/会话绑定的未确认操作编号，不加载旧 Durable 运行时。

`npm run build --workspace @amazme/web` 生成 `dist/page`。Python Host 在源码模式读取该目录，冻结包将同一目录装入资源；`npm run dev:web` 会先构建客户端。HTTP/事件类型及运行时校验由 `backend/tools/export_contracts.py` 从 Python 生成到 `src/generated/`（`contracts.ts`、`schema.json`），`--check` 检查漂移。

原界面的恢复和调用接线仍在实施，实际完成项以现行台账为准；不要把旧 Python 验证页当作正式客户端。

现行契约见 [Python 方案](../../docs/python-backend-plan.md)。

回答中的本地 Markdown 链接可打开文件停靠栏，如 `[源码](src/main.py:42)`、`[源码](src/main.py:42:9)` 或 `[源码](src/main.py#L42-L45)`。列号和范围定位到起始行；相对路径以会话工作区为基准，绝对路径必须属于当前项目的工作区。文件名里的字面冒号、井号用 `%3A`、`%23` 转义，含空格的目标可写成 `<src/a file.py:42>`。

行定位按需读取最多 1 MiB 的前缀，显示目标附近最多 2000 行；超出范围时明确提示。分页间版本变化会停止预览，切换会话或关闭文件面板后不再接收旧读取结果。HTTP(S) 裸链接自动识别，中文标点和 Unicode 符号保留在链接外，Unicode 字母仍可用于路径；行内代码和代码块保持原文。
