# @amazme/web

回环页面。它附着在 `@amazme/coding-agent` 里已经打开的宿主上：宿主负责 HTTP、WebSocket 与启动清单，
这个包只有文档、启动契约，以及把宿主复制的状态投影成块的纯逻辑与薄 DOM 渲染器。

- `src/contract.ts`：启动清单（产品名与版本、mode、协议版本、server id、传输 URL）与注入标记。
- `src/view.ts`：纯投影，把宿主的 `ConversationView` 与名册状态映射成名册项与 transcript 块；TUI 与网页
  共用同一份 durable 视图数据，只有渲染器不同。
- `src/render.ts`：只做 DOM，不持有状态。
- `src/index.html`：文档骨架，启动清单注入在 `<!--amazme-boot-->` 处。
- `src/assets.ts`：宿主用来定位页面目录、文档与静态资源（仅供 Node 侧，浏览器入口不引用它）。

这个包不打开会话存储、不执行工具、也不调用模型；这些都在宿主里。浏览器侧入口在
`packages/coding-agent/src/experimental/web/page.ts`，它绑定宿主的服务并驱动 composer。
