# @amazme/tui

全屏客户端。它附着在已经打开的宿主 socket 上，渲染订阅窗口，并把按键变成提交、中止、换对话或压缩。

这个包不打开 JSONL，不创建工具，也不选择模型。宿主进程在 `@amazme/coding-agent`。依赖只到 `@amazme/client` 和 `@amazme/runtime-service`，外加旧屏还用到的 `@amazme/agent` 事件类型。不要从这里导入 `@amazme/durable` 或 `@amazme/coding-agent`。
