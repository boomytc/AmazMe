# @amazme/tui

这是 AmazMe 第一个大版本的全屏客户端。没有版本 1 标头的会话或 runtime 文件由宿主拒绝，画面不会迁移它们。

全屏客户端。它附着在已经打开的宿主 socket 上。画面是对话、底栏和最下面的输入行；输入 `/` 时在输入行上方列出匹配命令。文字用深色终端上的强调色、暗色和绿色状态。`/login` 不带参数时打开供应商列表，由宿主传入的目录和登录回调完成；这个包不读写凭证。未知的 `/` 行留在画面上，不会发给模型。

这个包不打开 JSONL，不创建工具，也不选择模型。宿主进程在 `@amazme/coding-agent`。依赖只到 `@amazme/client` 和 `@amazme/runtime-service`，外加旧屏还用到的 `@amazme/agent` 事件类型。不要从这里导入 `@amazme/durable` 或 `@amazme/coding-agent`。
