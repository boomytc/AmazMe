# @amazme/mcp

独立的 Model Context Protocol 客户端。不依赖 `@amazme/ai`、`@amazme/agent`、`@amazme/durable` 或 `@amazme/coding-agent`。服务器进程、浏览器授权和 TUI 由调用方负责。

协议依据是 Model Context Protocol 修订版 `2026-07-28`（`modelcontextprotocol/modelcontextprotocol` 的 `docs/specification/2026-07-28`，2026-10-04 读取）。架构参考是本地 Pi `packages/mcp`，commit `76dfb88f63ce51ff2e3fe2ead4fcf1f65f71f121`。那份代码仍只说 `2025-11-25`，不能把它当成当前规范。

## 代际

当前修订没有 `initialize`。每个请求在 `_meta` 里带 `io.modelcontextprotocol/protocolVersion` 和 `io.modelcontextprotocol/clientCapabilities`。客户端先发 `server/discover`。

- 结果里的 `supportedVersions` 含 `2026-07-28`：保持现代协议，不发 `initialize`。
- 错误码 `-32022`、`-32021`、`-32020`：对方是现代服务器。版本对不上就失败，不退回握手。
- 其他错误，或 discover 超时：退回 `initialize`，接受 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`。
- 显式传入上述旧版本时，跳过 discover。

`2026-07-28` 把空字符串当作下一页游标。旧服务器里的 `""` 和 `null` 仍表示分页结束。

进度通知会重开空闲超时，不会推迟 `maxTimeoutMs`。`initialize` 超时不发送 `notifications/cancelled`。`resultType: "input_required"` 会失败，本包不自动再请求。

`toLlmContent` 把工具结果投影成文本和图片。音频、资源链接和其他二进制内容变成短占位文本。没有内容块时，`structuredContent` 变成 JSON。

## 范围

这一层提供协议核心和内存传输 `createInMemoryTransportPair()`。stdio、Streamable HTTP 和 OAuth 不在本文件所描述的已实现范围内，调用方不能把内存 fixture 当成真实服务器验收。

不实现采样、任务、`subscriptions/listen`、旧的 HTTP+SSE，也不打开浏览器。
