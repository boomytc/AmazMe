# @amazme/web

回环页面。它附着在 `@amazme/coding-agent` 里已经打开的宿主上：宿主负责 HTTP、WebSocket 与启动清单，
这个包只有页面文档与样式、启动契约，以及把宿主复制的状态投影成块的纯逻辑与薄 DOM 渲染器。

- `src/contract.ts`：启动清单（产品名与版本、mode、协议版本、server id、传输 URL）与注入标记。
- `src/view.ts`：纯投影，把宿主的 `ConversationView` 与名册状态映射成名册项与 transcript 块（含“是否正在跑”），
  TUI 与网页共用同一份 durable 视图数据，只有渲染器不同。
- `src/render.ts`：只做 DOM，不持有业务状态；唯一跨重建保留的是读者展开过哪一行。
- `src/theme.ts`：按系统外观在 `body` 上切 `data-ds-dark-theme`，与 DSH 的 boot-theme 同一套选择器。
- `src/assets.ts`：宿主用来定位页面目录、文档与静态资源（仅供 Node 侧，浏览器入口不引用它）。
- `src/page/`：页面静态资源。`index.html` 是文档骨架（启动清单注入在 `<!--amazme-boot-->` 处），
  `tokens.css` 是 DSH 设计平台的镜像（配色、别名、圆角、字体档、聚焦环、动效、投影、滚动条皮肤与首帧底色），
  `page.css` 是按 DSH 组件数值拼出的外壳与组件样式。

## 设计来源

样式对齐 `deepseek-harness` 的网页客户端：`tokens.css` 逐项镜像
`packages/client/ui-theme/src/styles/{base,design-platform,gradient-shadow-text,scrollbar,corner-shape,focus}.css`
的取值与变量名；`page.css` 的几何与排版取自 DSH 的
`ui-layout/AppFrame`、`ui-conversation/{ConversationRoot,InputBar}`、`ui-chat/{ChatView,MessageItem,AssistantMarkdown,ReasoningRow}`、
`ui-tool/{ToolRow,ToolDetails}`、`ui-primitives/DisclosureRow`、`ui-dockkit`、`ui-sidebar/SidebarRoot`。

有意保留的差异（页面没有对应的宿主能力或素材）：

- 品牌字样用系统字体：DSH 的 Montserrat 是它自己的品牌资源，没有随包引入。
- 侧栏在 1024px 以下整列隐藏：DSH 那里收成 56px 图标轨道，而页面没有轨道图标可放，收成空轨道没有意义。
- 图标用极简替代：DSH 每个工具、每行状态都有 14px 图标，这里的行前缀是 6px 状态圆点，composer 的主操作
  用自绘的 16px 箭头／圆角方块（DSH 的发送键是它图标集里的图形）。
- 工具结果只有一种卡片形态：DSH 按工具分视图（bash 走 mono 终端块，其余走 ToolDetails 卡片），这里统一用
  ToolDetails 卡片，所以 transcript 里没有 mono 文本。
- 状态行不带鲸鱼图标与流光动画，只保留 deep-diving 墨色。

这个包不打开会话存储、不执行工具、也不调用模型；这些都在宿主里。浏览器侧入口在
`packages/coding-agent/src/experimental/web/page.ts`，它绑定宿主的服务并驱动 composer。
