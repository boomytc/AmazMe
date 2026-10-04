# @amazme/tui

这是 AmazMe 第一个大版本的全屏客户端。没有版本 1 标头的会话或 runtime 文件由宿主拒绝，画面不会迁移它们。

全屏客户端。它附着在已经打开的宿主 socket 上。用户消息是一块带边的区域，助手文本按标题、列表和代码块排开。工具是标题加次要状态。底栏有工作目录、会话、模型和忙闲，输入行在横线下面。`/model`、`/thinking`、`/resume`、`/login` 不带参数时打开同一个可筛选列表。这个包不读写凭证，也不自己枚举模型。

这个包不打开 JSONL，不创建工具，也不选择模型。宿主进程在 `@amazme/coding-agent`。依赖只到 `@amazme/client` 和 `@amazme/runtime-service`，外加旧屏还用到的 `@amazme/agent` 事件类型。不要从这里导入 `@amazme/durable` 或 `@amazme/coding-agent`。
