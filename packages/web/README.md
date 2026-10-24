# @amazme/web

保留 Electron 使用的图标、语言匹配、错误文案与纯字体配置 helper。它不保存会话、账号或执行状态，也不加载旧 Durable 运行时。

产品网页由 Python 的 `backend/src/amazme_backend/web/` 提供；Web 和 Electron 共用这份页面及当前 HTTP/WebSocket 契约。旧 TS Host 的页面、投影与目录状态已随旧消费者删除。

现行契约见 [Python 方案](../../docs/python-backend-plan.md)。
