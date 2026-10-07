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
- `src/markdown.ts`：助手回答的纯排版单元（标题、列表、强调、链接、围栏代码、表格），从不解析 HTML，模型产出的标记
  只会成为文本。表格按分隔行定列对齐，没写对齐的列若整列都是数字则靠右并等宽显示数字，方便纵向比数。
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
- 代码块没有语言栏以外的装饰：DSH 的 `CodeBlock` 还有粘性语言栏、复制按钮和 shiki 高亮，这里只有语言栏、复制按钮与代码，
  没有高亮。
- 状态行不带鲸鱼图标与流光动画，只保留 deep-diving 墨色。
- 管理面是主区面板，不是 DSH 的插槽式桌面外壳：DSH 的插件面板、工作区树、右侧 dock 与首启说明来自它自己的宿主能力
  （工作区、上传端点、槽位注册），AmazMe 的切片没有这些插槽，所以这里的管理面是插件、技能、自动化、配置四块面板列，
  会话范围的工作区／终端／会话／任务则放在主区右侧的坞里；两者都不与 conversation 并排成插槽布局。

## 对齐与排版规则

页面按 LightUI 的“对齐”准则检查过一遍，落到样式里的几条：

- 盒子要装得下：`[hidden]` 的元素在 `page.css` 里各自写明 `display: none`。作者样式里的 `display` 会盖过 UA 表的
  `[hidden]`，否则隐藏的坞、附件条、审批区留在布局里，占着栅格轨道或边距。
- 窄窗只有一列：`body.dock-open` 与 `body` 都写了三／两条轨道，1023px 以下的媒体查询必须把两者都覆盖，否则会话列
  留在侧栏那条 280px 轨道里，右侧还给坞空着一条轨道。
- 头部的动作按钮不换行：标签换行会长过按钮 24px 的盒子并盖住下面的一行；640px 以下连接行让位（出错时才出现）。
- 数字成列就等宽：名册年龄、附件大小与表格里的数字列用 `tabular-nums`，表格里整列都是数字的列靠右。
- 名册的删除槽位常驻：悬停才出现的控件不参与挤压，年龄列因此不会在指针下移动。

这个包不打开会话存储、不执行工具、也不调用模型；这些都在宿主里。浏览器侧入口在
`packages/coding-agent/src/experimental/web/page.ts`，它绑定宿主的服务（会话范围的 transcript、agent-controller、models、
session-settings、commands、workspace、terminal、conversations、approvals，以及服务端范围的 settings、skills、plugins、
feedback、schedules），驱动 composer、侧栏的新建会话、模型／推理档切换，以及四个管理面板的动作分发。

## 运行控制、图片与会话面

- 运行控制：header 上的“压缩上下文”按钮打开一个可选填指令的模态框，提交走 `AgentController.compact()`；队列每条输入自带“撤回”，按 inbox submission id 调 `cancelQueued`；回合运行中 composer 出现“介入／排队”切换，提交即 `steer()` 或 `followUp()`；模型卡片底部有“刷新模型”与宿主回报的刷新状态。这些控件都是 `actions.ts` 里的动作 id，经与面板同一条 `command` 分发路径回到页面入口。
- 图片：composer 的附件按钮、粘贴与拖放都能加图，附件条给每张图缩略图、名字、大小与自己的移除控件；发送时按 `AgentPromptImage` 走真实 prompt 路径，durable 条目因此带上图片，transcript 里渲染成图片。页面按 PNG／JPEG／WebP／GIF 且 ≤8 MB 校验，不合格的选中项会给出原因而不是被静默丢弃。
- 会话面：名册每行显示会话 id、工作目录与年龄，悬停出现删除控件（先弹确认，再调 `SessionManagement.remove`）；名册上方是过滤框，按 id 或工作目录匹配，并区分“还没有会话”与“没有匹配”。切换视图、创建、附加、删除都不会清掉 composer 草稿、过滤文字或当前打开的管理视图。
- 连接抖动：附着与首次绘制都不会因为一次连接／附着重绑定把页面变成不可启动——附着失败会在连接行给出原因，绘制异常也在那里报告，页面继续可用。

## 会话工具坞（文件、终端、会话与任务）

主区右侧的坞（header 的 `Session tools` 按钮开关，窄窗随侧栏一起隐藏）放两个会话范围内的面：

- Files：宿主 `amazme.workspace` 的投影。列出会话工作目录（目录项打开、文件项读取、`Up` 回上一层），
  文本文件的内容整块显示，超出上限时标出“只显示开头”；二进制、路径不在工作目录内（拒绝）、已消失各有自己的提示。
  路径永远相对工作目录解析，越界请求被拒而不是被解析。
- Terminal：宿主 `amazme.terminal` 的投影。一行命令（Run／Stop），输出以受限缓冲流式进入状态，
  运行中可停止；状态行写明“正在运行谁”“结束退出码”“已停止”。终端复用 agent bash 工具的同一执行路径
  （本地 shell 操作、设置里的 shell 路径与前缀、同一个执行器做二进制清理与截断），所以网页与模型跑的是同一条路。
- Conversations：宿主 `amazme.conversations` 的投影。列出会话里的每个对话——主线标 `main`，子代理的子会话标出「由哪条 task 在哪条会话里创建」，当前聚焦的一条标 `selected`；点「打开」把主区切到那条对话。根对话仍用 Transcript 的实时视图，其他对话由服务发布一份（250ms 合并的）聚焦视图，宿主的 commit 流只用于给列表补标签。
- Tasks：同一服务的实时任务图，每条 task 给出 kind 与 id、阶段、状态、它等待哪些 task、拥有哪些会话，长跑时因此可读。
- 历史分页：transcript 顶部有「加载更早」。第一页以当前 transcript 最旧的条目为上界（`maxEntryId`），所以翻出来的内容一定在已显示内容之下、不会重复；之后按游标继续往回（每页 20 条，游标用完即止）。翻出来的条目按与实时 transcript 相同的投影排在 `.history-pages` 里，读法一致。
- 坞的输入行在重绘时复用同一个 DOM 节点，正在敲的命令与焦点不会被下方到来的输出冲掉。
- 会话 worker 现在也装上了 `subagent` 工具（TUI 的 durable runtime 一直有），所以网页里的一次真实运行可以派生子会话，并在列表与任务图里被正确归属。

## 工具审批

设置里的「审批 → 工具确认」有三档：`off`（直接运行）、`dangerous`（bash／powershell／write／edit 前询问）、
`all`（每次调用都询问）。会话 worker 在 Harness 打开前把 `beforeTool` 钩子装进自己的 registry（worker 的
approvals facet 提供 `amazme.approvals` 的状态）：命中策略的调用会被发布成一条待批请求（工具名、参数摘要、
task 与会话 id），钩子在那里等；页面在 composer 上方给出卡片，「通过」让调用照常运行，「拒绝」把这次调用
结算成失败的工具结果（`Denied by the reader: …`），回合继续往下走。这是工具边界上最小的一段暂停／恢复，
没有额外的策略引擎；回合被中止时待批请求按拒绝结算。`state` 是远程服务成员，所以服务对象上的 `state`
必须是数据属性而不是 getter。

## 命令、快捷键与复制

- 命令：composer 里以 `/` 开头的草稿打开命令面板。目录全部来自宿主 `amazme.commands` 的会话目录，三类：
  宿主自己的四条（model／thinking／compact／reload）、会话加载的 prompt 模板、以及技能（`/skill:<name>`，
  `enableSkillCommands` 关闭时不列出）。面板按前缀过滤，每行的来源以「模板／技能」标出（宿主自己的命令不带标），
  补上空格后改为请求宿主的参数补全（模型 id、推理档）；Tab 补全高亮的行，Enter 运行。
  运行分两条路：宿主自己的命令走 `Commands.run`，结果是 note 或 problem（命令结果因此是值而不是异常，避免 RPC
  把信息抹成一句话）；模板与技能走 `Commands.expand` 取回 prompt 文本，再由页面按自己的发送路径发给当前聚焦的
  对话。展开与终端同一份实现（模板用 `expandPromptTemplate`，技能用 `core/skill-command.ts` 的
  `<skill name location>` 块 + 参数），所以同一条命令在网页与终端给模型的文本一致。目录会随技能面板的改动与
  `enableSkillCommands` 开关自动重读，新写的技能不必重启 worker；新增模板文件按终端的老规矩走 `/reload`。
- 快捷键：`shortcuts.ts` 是一张表，同时用于读者可见的说明和按键匹配。产品键沿用 DSH 网页端的约定
  （`primary`＋Alt：⌘⌥N 新建会话、⌘⌥M 轮换管理视图）；`/` 在不处于输入框时聚焦 composer；回合运行中连按两次
  Esc 停止（阈值 500ms，与 TUI、DSH 的 stopSequence 一致）。`Escape` 仍然优先关闭模态框、视图卡片与模型卡片。
- 复制：围栏代码块的 banner 上带复制控件，写进剪贴板的就是代码本身，成功/失败在控件文字上显示。

## 交互状态：进行中、失败与焦点

管理面的一次调用有它自己的状态，页面对此只有一处描述：`panels.ts` 的 `PanelSpec.pending` 与
`PanelModal.pending`／`notice`。页面把「正在进行的动作（动作 id + 对象）」和「它上一次说的话」交给
`panelView`，纯层把进行中的那个控件标成 busy（渲染器据此禁用并加 `.pending`），把消息排在面板通知之前、
或放进模态框卡片里自己的一行。因此：

- 面板行按钮或模态框提交在调用进行中会变灰并拒绝第二次点击；成功后回到常态，面板按宿主发布的新状态重绘。
- 调用被拒或失败时，原因出现在**发起它的那个控件旁边**（面板的 `.panel-notice.error` 或模态框的
  `.modal-notice.error`），模态框保持打开并保留已输入的内容，成功后再关闭。
- 用 Esc 或关闭控件关掉模态框时，焦点回到打开它的那个控件（按动作 id + 对象重新查找，因为重绘会换掉节点）。
- 这些调用都经过与附着同样的重绑定重试：删除当前附着的会话本身会释放本连接的附着，调用因此在其后发出并在
  绑定被替换时重试一次。

组件状态一律取自 token：`:hover` 用 `--dsw-alias-interactive-bg-hover`、输入类用 `--dsw-alias-border-l4`
加强边框、主按钮用 `--dsw-alias-button-info-hover`、开关悬停用同一填充做 2px 光晕；`:focus-visible` 的
2px 环来自 `tokens.css` 的全局规则（DSH 的 focus.css 镜像），`page.css` 不新增颜色字面量。

## 消息反馈与首启引导

- 消息反馈：每条已提交的助手回答下面有一对拇指控件（`feedback:up`／`feedback:down`，`data` 是条目 id）。
  评分存在宿主 agent 目录的 `feedback.json`（服务端范围的 `amazme.feedback`），CLI 也能读到同一份文件；
  同一条回答再评一次是替换而不是追加，再点同一个拇指是撤回。控件只在“这条回答存在且已结算”时出现，
  正在流式输出的回合没有控件；没有反馈服务时整排控件不渲染。
- 首启引导：宿主的会话名册为空（且已连上、有工作目录）时，主区显示一张欢迎卡片：三步入口（新建会话、
  打开文件与终端、看看设置）各带一个动作，以及“不再显示”。“不再显示”把 `showWelcome` 写成 `false`
  （写进 agent 的 `settings.json`），之后不再出现；在设置面板的「界面 → 欢迎引导」里可以重新打开。

## 自动化：宿主自己跑的定时任务

侧栏的 Automation 是服务端范围的 `amazme.schedules` 的投影：每个任务写明提示、间隔（最少 1 分钟）、
归属会话、下次到点时间与上次运行的结果，行上有「立即运行」、启停开关与删除（先弹确认）。

- 存储：`<agentDir>/schedules.json`，原子写入（临时文件＋改名），激活时读回，`reload` 可丢弃别处的改动；
  文件本身是 CLI 也能读的形状。
- 运行：宿主自己每 5 秒查一次到期任务并顺序执行；每次运行是“附加该会话的 worker → `AgentController.prompt`
  → `waitForPrompt`”这条真实路径，所以回答会出现在那个会话的 transcript 里，`lastOutcome` 记的是这次运行的
  结局（`Answered.` / `No answer: …` / `failed: …`），不是“已提交”。任务在页面关着时照跑。
- 一次运行可能长达几分钟，所以它不占宿主那条共享的串行变更队列；文件自己的读写在这个服务内部排队，
  并且同一时刻只有一趟到期检查。
- 「立即运行」对暂停中的任务也有效，且不会改动它的周期；暂停只影响宿主自己的到期检查。

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

侧栏里的 Plugins、Skills、Automation 与底部的 Settings 切换主区：打开面板时 conversation 与 composer 让位给面板列，标题带上返回箭头。
面板的行、控件与按钮全部来自 `src/panels.ts` 的纯映射，动作只是 id 加对象，由入口解释成宿主调用。

- Plugins：插件包（宿主按 server 默认选择构建并写入 server profile，对之后打开的会话生效）与 MCP 服务器
  （`mcp.json` 的增删、启停与 exposure；这些条目由 CLI 与 TUI 连接，实验性网页宿主目前不连 MCP）。
- Skills：宿主自己加载的技能清单；agent 目录下的技能可新建、编辑、删除、导入，项目与配置路径里的技能只读展示。
  技能和 CLI 一样在会话启动时载入，改动对新会话生效。
- Settings：宿主发布的字段目录（分组 token、类型、枚举取值、写入的 settings 键，以及“是否由文件显式设置”），
  标签与说明由页面按 id 给出；第一组“界面”就是语言与外观。改动写进全局 `settings.json`；面板同时列出文件路径与
  解析错误，并提供“重新读取文件”。数字控件在本地按宿主的范围校验（超范围的草稿留在输入框里并标出，不发出请求），
  其余校验仍由宿主负责。已连接的会话会被要求重读设置，因此压缩、重试、steering 这类逐轮读取的字段立即生效。
- Automation：宿主自己跑的定时任务（见上），每行给出下次到点时间与上次运行的结果；新建走一个模态框（提示 + 间隔分钟数），
  间隔不是不少于 1 的整数、或提示为空时在本地就拒绝并给出原因。未附加会话时“新建”不可用，面板顶部说明原因。
