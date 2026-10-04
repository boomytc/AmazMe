# @amazme/mcp

独立的 Model Context Protocol 客户端。不依赖 `@amazme/ai`、`@amazme/agent`、`@amazme/durable` 或 `@amazme/coding-agent`。服务器进程、浏览器授权和 TUI 由调用方负责。

协议依据是 Model Context Protocol 修订版 `2026-07-28`（`modelcontextprotocol/modelcontextprotocol` 的 `docs/specification/2026-07-28`，2026-10-04 读取）。架构参考是本地 Pi `packages/mcp`，commit `76dfb88f63ce51ff2e3fe2ead4fcf1f65f71f121`。那份代码仍只说 `2025-11-25`，不能把它当成当前规范。

## 代际

当前修订没有 `initialize`。每个请求在 `_meta` 里带 `io.modelcontextprotocol/protocolVersion` 和 `io.modelcontextprotocol/clientCapabilities`。客户端先发 `server/discover`。

- 结果里的 `supportedVersions` 含 `2026-07-28`：保持现代协议，不发 `initialize`。
- 错误码 `-32022`、`-32021`、`-32020`：对方是现代服务器。版本对不上就失败，不退回握手。
- stdio 上的其他 JSON-RPC 错误，或 discover 超时：退回 `initialize`。
- Streamable HTTP 上，只有状态码 400 且正文不是上述现代错误、也不是方法不存在时，才退回 `initialize`。404 带方法不存在、超时，以及其他状态码，都不握手。
- 显式传入旧版本时，跳过 discover。

退回后接受 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`。

`2026-07-28` 把空字符串当作下一页游标。旧服务器里的 `""` 和 `null` 仍表示分页结束。

进度通知会重开空闲超时，不会推迟 `maxTimeoutMs`。`initialize` 超时不发送 `notifications/cancelled`。现代 HTTP 取消只中止这一次 POST，不另发 `notifications/cancelled`。`resultType: "input_required"` 会失败，本包不自动再请求。

`toLlmContent` 把工具结果投影成文本和图片。音频、资源链接和其他二进制内容变成短占位文本。没有内容块时，`structuredContent` 变成 JSON。

## 传输

- 内存传输 `createInMemoryTransportPair()` 只给测试用。
- stdio 用换行分隔的 JSON-RPC。stderr 只是日志，不当成失败。关闭时先关 stdin，再 SIGTERM，再向进程组发 SIGKILL。旧服务器仍可能发来 `roots/list` 或 `ping`，客户端会回答；2026 的服务器不应再发 JSON-RPC 请求。
- Streamable HTTP 的现代请求带 `MCP-Protocol-Version`、`Mcp-Method` 和需要的 `Mcp-Name`。`Mcp-Name` 按规范做 Base64。现代模式没有会话 id，没有 GET 流，也不用 `Last-Event-ID` 续传。
- 旧修订版才保存 `Mcp-Session-Id`，在 `notifications/initialized` 之后打开 GET SSE，并在响应流或 GET 流中断后用 `Last-Event-ID` 续传。关闭时对旧会话发 DELETE。
- 不生成 `Mcp-Param-*`。传输层看不到工具的 `inputSchema`，不能靠扫参数去补 `x-mcp-header`。
- 不实现 2024-11-05 的 HTTP+SSE。没有现代 JSON-RPC 正文的 404 或 405 会失败，不会改走那条传输。
- `AuthProvider` 在 401，或带 `insufficient_scope` 的 403 之后，让同一次刷新重试一遍。第二次仍失败就抛出 `McpAuthRequiredError`，错误文本不包含 bearer token。OAuth 发现、PKCE 和凭证文件还不在这个包里。

本地子进程和 `127.0.0.1` fixture 不是真实 MCP 服务器验收，也不是真实 OAuth 验收。

## 范围

不实现采样、任务、`subscriptions/listen`，也不打开浏览器。
