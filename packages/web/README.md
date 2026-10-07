# @amazme/web

回环页面。它附着在 `@amazme/coding-agent` 里已经打开的宿主上：宿主负责 HTTP、WebSocket 与启动清单，
这个包只有页面文档与样式、启动契约，以及把宿主复制的状态投影成块的纯逻辑与薄 DOM 渲染器。

- `src/contract.ts`：启动清单（产品名与版本、mode、协议版本、server id、传输 URL）与注入标记。
- `src/view.ts`：纯投影，把宿主的 `ConversationView` 与名册状态映射成名册项与 transcript 块；TUI 与网页
  共用同一份 durable 视图数据，只有渲染器不同。
- `src/render.ts`：只做 DOM，不持有业务状态。
- `src/assets.ts`：宿主用来定位页面目录、文档与静态资源（仅供 Node 侧，浏览器入口不引用它）。
- `src/page/`：页面静态资源。`index.html` 是文档骨架（启动清单注入在 `<!--amazme-boot-->` 处），
  `tokens.css` 是 DSH 设计平台的镜像（配色、别名、圆角、字体阶梯、动效、投影、滚动条皮肤），
  `page.css` 是按 DSH 组件数值拼出的外壳与组件样式。

## 设计来源

样式对齐 `deepseek-harness` 的网页客户端：`tokens.css` 逐项镜像
`packages/client/ui-theme/src/styles/{base,design-platform,gradient-shadow-text,scrollbar,corner-shape,focus}.css`
的取值与变量名；`page.css` 的几何与排版取自 DSH 的
`ui-layout/AppFrame`、`ui-conversation/{ConversationRoot,InputBar}`、`ui-chat/{ChatView,MessageItem,AssistantMarkdown,ReasoningRow}`、
`ui-tool/{ToolRow,ToolDetails}`、`ui-primitives/{DisclosureRow,Button}`、`ui-dockkit`、`ui-sidebar/SidebarRoot`。

有意保留的差异（页面没有对应的宿主能力或素材）：

- 品牌字样用系统字体：DSH 的 Montserrat 是它自己的品牌资源，没有随包引入。
- 侧边栏固定 280px：DSH 在 1024px 以下会收成 56px 图标轨道，页面没有轨道图标可放，因此不收折。
- 工具行前缀是 6px 状态圆点：DSH 每个工具都有 14px 图标，这里没有图标集。
- 状态行不带鲸鱼图标与流光动画，只保留 deep-diving 墨色。

这个包不打开会话存储、不执行工具、也不调用模型；这些都在宿主里。浏览器侧入口在
`packages/coding-agent/src/experimental/web/page.ts`，它绑定宿主的服务并驱动 composer。
