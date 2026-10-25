# @amazme/web

Web 和 Electron 共用的原客户端呈现：导航、聊天、模型连接、管理面板和会话停靠栏。会话、账号与执行状态归 Python Host 所有；本包保留草稿、界面偏好和按宿主/会话绑定的未确认操作编号，不加载旧 Durable 运行时。

`npm run build --workspace @amazme/web` 生成 `dist/page`。Python Host 在源码模式读取该目录，冻结包将同一目录装入资源；`npm run dev:web` 会先构建客户端。HTTP/事件类型及运行时校验由 `backend/tools/export_contracts.py` 从 Python 生成，`--check` 检查漂移。

原界面的恢复和调用接线仍在实施，实际完成项以现行台账为准；不要把旧 Python 验证页当作正式客户端。

现行契约见 [Python 方案](../../docs/python-backend-plan.md)。
