# @amazme/tui

这是 AmazMe 第一个大版本的全屏客户端。没有版本 1 标头的会话或 runtime 文件由宿主拒绝，画面不会迁移它们。

全屏客户端。它附着在已经打开的宿主 socket 上。用户消息是一块带边的区域，助手文本按标题、列表和代码块排开。工具是标题加次要状态。底栏依次是模型、思考档位、工作目录、会话和忙闲；token、上下文占比、命中率和花费只显示外面放进状态的数字，这个包不估算。忙的时候，这一轮里已经排队的后续消息显示「排队 N」。底栏下面常驻换行、快捷键和退出提示。输入框有边框和占位。Enter 发送，Shift+Enter 换行，终端分不出 Shift+Enter 时用 Alt+Enter。上下键只在第一行或最后一行翻历史。粘贴走括号粘贴，里面的换行不发送。输入为空时 `?` 打开快捷键浮层，Esc 关闭；浮层和 `/hotkeys` 用同一份按键表。`/model`、`/thinking`、`/resume`、`/login` 不带参数时打开同一个可筛选列表。这个包不读写凭证，也不自己枚举模型。

这个包不打开 JSONL，不创建工具，也不选择模型。宿主进程在 `@amazme/coding-agent`。依赖只到 `@amazme/client` 和 `@amazme/runtime-service`。不要从这里导入 `@amazme/agent`、`@amazme/ai`、`@amazme/durable` 或 `@amazme/coding-agent`。
