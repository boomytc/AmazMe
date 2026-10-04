# @amazme/mcp

独立的 Model Context Protocol 客户端。不依赖 `@amazme/ai`、`@amazme/agent`、`@amazme/durable` 或 `@amazme/coding-agent`。服务器进程、浏览器授权和 TUI 由调用方负责。

协议客户端和 transports 从 `@amazme/mcp` 导入；OAuth 从独立的 `@amazme/mcp/oauth` 导入，根入口不加载授权流程；内存测试通道从 `@amazme/mcp/testing` 导入。

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
- 现代 HTTP 的 `tools/list` 结果会保存合法的 `x-mcp-header` 映射，按属性路径把标注的 string、integer、boolean 参数编码到 `Mcp-Param-*`。null 和缺省值不生成头。非法标注工具在发现时被过滤并报告，错误参数在发送前失败；映射不会改写原 schema，也不会扫描未标注参数。
- 不实现 2024-11-05 的 HTTP+SSE。没有现代 JSON-RPC 正文的 404 或 405 会失败，不会改走那条传输。
- `AuthProvider` 在 401，或带真实 Bearer `error="insufficient_scope"` 参数的 403 之后，让同一次刷新重试一遍。引号内描述和其他认证方案不触发 step-up。第二次仍失败就抛出 `McpAuthRequiredError`，错误文本不包含 bearer token。
- OAuth 发现、PKCE、刷新和 step-up 在本包内。动态注册会带 `application_type`；调用方没写时用 `native`，写了 `web` 就保留。调用方提供 Client ID Metadata Document 时不再动态注册。授权响应里的 `iss`，以及元数据声明会返回 `iss` 时，必须和发现到的 issuer 一致。凭证按 MCP 服务器地址分开保存。受保护资源元数据给出的 issuer 变了，就丢掉这个授权服务器签发的 client 和 token，不把它们发给新的授权服务器。这次没拿到受保护资源元数据时，仍用已经记录的 issuer。刷新失败不写入半份凭证，也不再发这一次 MCP 请求。`onRedirect` 只把授权地址交给调用方，本包不打开浏览器。`OAuthCallbackServer` 可以在 `127.0.0.1` 上等待回调。凭证放在调用方提供的 store 里，本包不选择凭证文件，也不读取真实密钥。

本地子进程、`127.0.0.1` fixture 和注入的 fetch 不是真实 MCP 服务器验收，也不是真实 OAuth 登录验收。

关闭会终止待处理请求和流读取；重复关闭会等待同一次清理。取消只影响对应请求，迟到响应不会重新结算。HTTP JSON 和 SSE 消息都受读量上限约束，响应 id 必须属于当前 POST。授权请求可取消，令牌和动态注册的 POST 不自动跟随重定向。`McpOAuthProvider` 不发出已经过期的 access token。凭证写入失败不会堵住后续写入。

授权重定向会先保存 discovery、client、redirect URI、PKCE verifier、state 和请求 scope 的同一份快照。回调兑换必须提供该快照的 state，并传入回调里的 `iss`；服务器元数据要求 `iss` 时不能省略。`McpOAuthProvider.state()` 每次生成新值，读取正在等待的 state 应使用 `authorizationState()`。`OAuthCallbackServer.waitForCallback()` 支持 `issuer`、`requireIss`、`path` 和 `signal`，调用方需按当前授权记录设置这些选项，并把返回的 `state`、`iss` 和 `code` 交给 `authorizeMcp()`。

自定义 `OAuthClientProvider` 必须保存和读取 discovery、授权快照及请求 scope，并能失效凭证；没有待兑换快照时不接受授权码。自定义 provider 还负责令牌有效期和服务器地址归属；共享 store 的 provider 用同一个协调键串行授权及刷新。取消能停止等待，但不能撤回调用方 store 已接受的写入；跨进程的原子持久化由 store 实现负责。

## 范围

不实现采样、任务、`subscriptions/listen`。回调监听不打开浏览器。
