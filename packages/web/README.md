# @amazme/web

回环页面。它附着在 `@amazme/coding-agent` 里已经打开的宿主上：宿主负责 HTTP、WebSocket 与启动清单，
这个包只有页面文档与样式、启动契约，以及把宿主复制的状态投影成块的纯逻辑与薄 DOM 渲染器。

- `src/contract.ts`：启动清单（产品名与版本、mode、协议版本、server id、传输 URL，以及宿主读到的语言与外观偏好）与注入标记。
- `src/locale.ts`：页面支持的语言（中／英）、存进设置里的偏好（`auto` 表示随浏览器），以及“偏好优先、否则按浏览器语言匹配”的解析。
- `src/strings.ts`：两种语言的文案字典。页面自己的界面文案是平铺的消息键（`zh` 被声明为 `en` 的完整 Record，漏一条就编译不过），
  宿主设置目录的 id、分组 token 与枚举取值则在这里被命名成词；`localizeDocument` 把宿主送来的静态外壳里的 `{{消息键}}` 标记
  换成本次请求的语言，并写上 `<html lang>`。
- `src/view.ts`：纯投影，把宿主的 `ConversationView`、名册状态与 `amazme.models` 配置映射成名册项、transcript 块
  （含“是否正在跑”）、新建会话控件与 composer 的模型／推理档选择器，TUI 与网页共用同一份 durable 视图数据，
  只有渲染器不同。
- `src/panels.ts`：管理面的视图模型。面板被描述成“一组行”——标题、可选的值行、控件（开关／下拉／数字／文本）与按钮，
  每个控件与按钮带一个动作 id 和它作用的对象（设置字段、技能名、路径）。这里只做纯映射，渲染器因此不需要知道
  插件、技能、设置的任何业务含义；再加一个管理面就是再多一个纯函数。构建函数接收语言，把宿主发布的身份（字段 id、
  分组 token、枚举取值）翻成读者语言的标签，所以文案只有这一处，宿主不送句子。
- `src/markdown.ts`：助手回答的纯排版单元（标题、列表、强调、链接、围栏代码），从不解析 HTML，模型产出的标记
  只会成为文本。
- `src/render.ts`：只做 DOM，不持有业务状态；唯一跨重建保留的是读者展开过哪一行、模型卡片是否打开、面板文本控件里
  读者正在敲的内容，以及模态框的构建时机（避免重建吞掉输入）。
- `src/theme.ts`：外观偏好（`system`／`light`／`dark`）与 `body[data-ds-dark-theme]` 的对应，与 DSH 的 boot-theme 同一套
  选择器；`system` 时跟随系统且响应系统切换，固定值时忽略系统。
- `src/assets.ts`：宿主用来定位页面目录、文档与静态资源（仅供 Node 侧，浏览器入口不引用它）。
- `src/page/`：页面静态资源。`index.html` 是文档骨架（启动清单注入在 `<!--amazme-boot-->` 处），
  `tokens.css` 是 DSH 设计平台的镜像（配色、别名、圆角、字体档、聚焦环、动效、投影、菜单面、滚动条皮肤与首帧底色），
  `page.css` 是按 DSH 组件数值拼出的外壳与组件样式。

## 设计来源

样式对齐 `deepseek-harness` 的网页客户端：`tokens.css` 逐项镜像
`packages/client/ui-theme/src/styles/{base,design-platform,gradient-shadow-text,scrollbar,corner-shape,focus}.css`
的取值与变量名；`page.css` 的几何与排版取自 DSH 的
`ui-layout/AppFrame`、`ui-conversation/{ConversationRoot,InputBar}`、`ui-chat/{ChatView,MessageItem,AssistantMarkdown,ReasoningRow}`、
`ui-tool/{ToolRow,ToolDetails}`、`ui-model-selection/ModelSelect`、`ui-sidebar/SidebarRoot`、
`ui-primitives/{DisclosureRow,MarkdownText,CodeBlock,Menu,MenuSurface}`、`ui-dockkit`。

有意保留的差异（页面没有对应的宿主能力或素材）：

- 界面文案与它的语言：页面与宿主发布的数据分家——宿主只送设置字段的 id、分组 token、枚举取值等身份，词句在
  `src/strings.ts` 的两份字典里，和 TUI 设置选择器各自持有自己的英文文案是同一个做法。宿主的诊断信息（技能加载器、
  `mcp.json` 校验、设置文件解析）保持宿主自己写的语言，不随界面语言变化；TUI 也仍是英文，`locale` 设置目前只被网页读取。

- 品牌字样用系统字体：DSH 的 Montserrat 是它自己的品牌资源，没有随包引入。
- 侧栏在 1024px 以下整列隐藏：DSH 那里收成 56px 图标轨道，而页面没有轨道图标可放，收成空轨道没有意义。
  这个宽度下管理入口改挂在头部（一个 `⋯` 按钮加同一份导航行的卡片），否则管理面板就点不到了。
- 图标用极简替代：DSH 每个工具、每行状态都有 14px 图标，这里的行前缀是 6px 状态圆点，composer 的主操作
  用自绘的 16px 箭头／圆角方块，侧栏的新建会话行用自绘的 16px 会话框（DSH 的那些图形来自它自己的图标集）。
- 工具结果只有一种卡片形态：DSH 按工具分视图（bash 走 mono 终端块，其余走 ToolDetails 卡片），这里统一用
  ToolDetails 卡片，所以 transcript 里没有 mono 文本。
- 代码块没有语言栏以外的装饰：DSH 的 `CodeBlock` 还有粘性语言栏、复制按钮和 shiki 高亮，这里只有语言栏与代码，
  没有高亮和复制。
- 状态行不带鲸鱼图标与流光动画，只保留 deep-diving 墨色。
- 管理面是主区面板，不是 DSH 的插槽式桌面外壳：DSH 的插件面板、自动化任务、工作区树、右侧 dock 与首启说明来自
  它自己的宿主能力（工作区、定时任务、上传端点、槽位注册），AmazMe 的切片没有这些服务，所以这里只有插件、技能、
  配置三块，并且都是面板列而不是并排的附栏。

这个包不打开会话存储、不执行工具、也不调用模型；这些都在宿主里。浏览器侧入口在
`packages/coding-agent/src/experimental/web/page.ts`，它绑定宿主的服务（transcript、agent-controller、models、
session-settings，以及服务端范围的 settings、skills、plugins），驱动 composer、侧栏的新建会话、模型／推理档切换，
以及三个管理面板的动作分发。

## 运行控制、图片与会话面

- 运行控制：header 上的“压缩上下文”按钮打开一个可选填指令的模态框，提交走 `AgentController.compact()`；队列每条输入自带“撤回”，按 inbox submission id 调 `cancelQueued`；回合运行中 composer 出现“介入／排队”切换，提交即 `steer()` 或 `followUp()`；模型卡片底部有“刷新模型”与宿主回报的刷新状态。这些控件都是 `actions.ts` 里的动作 id，经与面板同一条 `command` 分发路径回到页面入口。
- 图片：composer 的附件按钮、粘贴与拖放都能加图，附件条给每张图缩略图、名字、大小与自己的移除控件；发送时按 `AgentPromptImage` 走真实 prompt 路径，durable 条目因此带上图片，transcript 里渲染成图片。页面按 PNG／JPEG／WebP／GIF 且 ≤8 MB 校验，不合格的选中项会给出原因而不是被静默丢弃。
- 会话面：名册每行显示会话 id、工作目录与年龄，悬停出现删除控件（先弹确认，再调 `SessionManagement.remove`）；名册上方是过滤框，按 id 或工作目录匹配，并区分“还没有会话”与“没有匹配”。切换视图、创建、附加、删除都不会清掉 composer 草稿、过滤文字或当前打开的管理视图。
- 连接抖动：附着与首次绘制都不会因为一次连接／附着重绑定把页面变成不可启动——附着失败会在连接行给出原因，绘制异常也在那里报告，页面继续可用。

## 命令、快捷键与复制

- 命令：composer 里以 `/` 开头的草稿打开命令面板。面板先按前缀过滤会话自己发布的命令目录（`amazme.commands`：
  model／thinking／compact／reload），补上空格后改为请求宿主的参数补全（模型 id、推理档）；Tab 补全高亮的行，
  Enter 运行。`enableSkillCommands` 打开时，页面把已加载技能追加成 `/skill:<name>`，运行它时按 CLI 的
  `_expandSkillCommand` 形状（`<skill name location>` 块 + 参数）展开成一次 prompt。执行结果显示在连接行：
  成功是宿主的 note，失败是 problem（命令结果因此是值而不是异常，避免 RPC 把信息抹成一句话）。
- 快捷键：`shortcuts.ts` 是一张表，同时用于读者可见的说明和按键匹配。产品键沿用 DSH 网页端的约定
  （`primary`＋Alt：⌘⌥N 新建会话、⌘⌥M 轮换管理视图）；`/` 在不处于输入框时聚焦 composer；回合运行中连按两次
  Esc 停止（阈值 500ms，与 TUI、DSH 的 stopSequence 一致）。`Escape` 仍然优先关闭模态框、视图卡片与模型卡片。
- 复制：围栏代码块的 banner 上带复制控件，写进剪贴板的就是代码本身，成功/失败在控件文字上显示。

## 语言与外观

界面语言（中／英）与外观（浅色／深色／跟随系统）是两个存在 agent 的 `settings.json` 里的偏好
（`locale`：`auto`／`zh`／`en`，`appearance`：`system`／`light`／`dark`），在管理面板的第一组“界面”里改，
和 CLI、TUI 共用同一份设置文件，所以换台浏览器也一样。页面与面板按“偏好优先，否则按 `navigator.languages`
匹配，都不匹配就用英文”解析语言；`auto` 就是交给浏览器。

宿主在每次响应文档时读一遍这两个偏好（它自己开一个 `SettingsManager`，读的是同一份文件），把偏好写进启动清单，
并按 `Accept-Language` 解析语言后本地化静态外壳：侧栏文案、空状态、按钮的 aria 标签在 HTML 到达时就已是该语言，
首帧不会闪英文，`<html lang>` 也正确。外观偏好同样写进清单，文档头部的调色板脚本按它决定首帧是浅色还是深色
（`system` 才看 `prefers-color-scheme`），页面随后用同一份偏好继续跟随设置变化。在面板里切换语言或外观时，
页面不需要刷新：写进设置后经复制的设置状态回到页面，重绘即换语言、换调色板。

## 管理面

侧栏里的 Plugins、Skills 与底部的 Settings 切换主区：打开面板时 conversation 与 composer 让位给面板列，标题带上返回箭头。
面板的行、控件与按钮全部来自 `src/panels.ts` 的纯映射，动作只是 id 加对象，由入口解释成宿主调用。

- Plugins：插件包（宿主按 server 默认选择构建并写入 server profile，对之后打开的会话生效）与 MCP 服务器
  （`mcp.json` 的增删、启停与 exposure；这些条目由 CLI 与 TUI 连接，实验性网页宿主目前不连 MCP）。
- Skills：宿主自己加载的技能清单；agent 目录下的技能可新建、编辑、删除、导入，项目与配置路径里的技能只读展示。
  技能和 CLI 一样在会话启动时载入，改动对新会话生效。
- Settings：宿主发布的字段目录（分组 token、类型、枚举取值、写入的 settings 键，以及“是否由文件显式设置”），
  标签与说明由页面按 id 给出；第一组“界面”就是语言与外观。改动写进全局 `settings.json`；面板同时列出文件路径与
  解析错误，并提供“重新读取文件”。数字控件在本地按宿主的范围校验（超范围的草稿留在输入框里并标出，不发出请求），
  其余校验仍由宿主负责。已连接的会话会被要求重读设置，因此压缩、重试、steering 这类逐轮读取的字段立即生效。
