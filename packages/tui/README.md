# @amazme/tui

这是 AmazMe 第一个大版本的全屏客户端。没有版本 1 标头的会话或 runtime 文件由宿主拒绝，画面不会迁移它们。

全屏客户端。它附着在已经打开的宿主 socket 上，渲染订阅窗口，并把按键变成提交、中止或一条斜杠命令。命令语法在 `parseSlash`：未知的 `/` 行留在画面上，不会发给模型。`/login` 和 `/logout` 由宿主进程传入的回调完成；这个包不读写凭证。

这个包不打开 JSONL，不创建工具，也不选择模型。宿主进程在 `@amazme/coding-agent`。依赖只到 `@amazme/client` 和 `@amazme/runtime-service`，外加旧屏还用到的 `@amazme/agent` 事件类型。不要从这里导入 `@amazme/durable` 或 `@amazme/coding-agent`。
