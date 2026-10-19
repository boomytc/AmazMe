# DeepSeek Web 工具

可选原生插件，提供 `web_search`、`web_fetch` 和 `/web`，默认不加载。参照 DeepSeek Harness `fda98dadd2` 的直连 Search/Fetch 设计，适配现有 Chord 插件和 Durable 工具执行；每次调用只发一个 API 请求，不额外生成模型回答。

在原生 TUI 中选择随 Coding Agent 交付的这个目录，例如从仓库根目录启动：

```sh
amazme -e ./packages/coding-agent/plugins/web
```

已安装版本使用其 `plugins/web` 绝对路径。也可用 `amazme install <目录>` 保存包选择；宿主会话按现有包配置选择。Print/RPC 的 SDK 扩展入口不加载原生 facet，不能用此插件。新选包需重启；修改源码后在空闲时 `/reload`。

加载后 API 仍关闭。先通过已有的 DeepSeek 登录配置保存 API Key，或设置 `DEEPSEEK_API_KEY`，再由用户执行：

```text
/web status
/web on
/web {"count":5,"sendOriginalQuestion":false}
/web {"baseURL":"https://gateway.example/prefix/tools"}
/web off
```

设置存于当前对话，重开恢复，人工分叉继承所选历史位置的值；不写入凭据。归档的分叉不能修改设置。切换焦点后，已开始的命令仍修改原对话。`off` 阻止后续调用；已经发出的请求仍使用进入调用时读取的设置，取消会话工作可中止它。

默认 `baseURL` 为 `https://api.deepseek.com/v1/tools`，分别追加 `/search`、`/fetch`。网关路径前缀须由用户显式配置，与聊天端点独立；模型参数不能启用 API 或修改端点。每次调用重新解析当前 `deepseek` 凭据，只发送 Bearer API Key，不转发聊天端点、附加请求头或 DSH 账号令牌。缺少凭据不发请求，HTTP 重定向直接失败。

| 设置 | 默认值 | 约束 |
| --- | --- | --- |
| `enabled` | `false` | 布尔值，用户显式启用 |
| `baseURL` | 官方 `/v1/tools` | HTTP(S)，无用户密码、query、fragment，最长 8192 字符 |
| `count` | `10` | 1–50；工具请求更少时取更小值 |
| `sendOriginalQuestion` | `true` | 向 Search 发送触发调用的实际用户输入，空白合并后取前 128 个 Unicode 字符；可关闭 |
| `timeoutMs` | `30000` | 1–300000，覆盖凭据解析、响应头和正文 |
| `maxResponseBytes` | `2097152` | 1–16777216，按实际响应字节限制，含分块传输 |
| `maxContentChars` | `20000` | 1–200000，限制返回文本的 UTF-16 长度，不截断代理对 |

`web_search` 接受 `query`（非空，最多 128 个 Unicode 字符）、可选 `count`。发送 `need_content:false`，只保留有序 URL、标题、摘录和非空日期。排队中的跟进消息、注入的 user-role 上下文不作为原始问题。`web_fetch` 接受 HTTP(S) URL（无用户密码，最长 8192 字符），返回 Markdown 和可选标题；接口不报告目标站点状态码或跳转终点，因此结果不推断这些信息。结果同时提供模型文本、结构化值和截断标记，网页内容只能作为不可信资料使用。

工具仍遵守当前会话的工具选择、审批和普通所属任务规则。两者虽只读，API 可能计费，故标记为 `replay: "unsafe"`；进程中断后不会自动重复发送，需新的显式工具调用。没有自动重试，也没有 Messages 辅助搜索或本地 HTTP 抓取回退。

验证使用本地 HTTP、模拟凭据/响应和 SQLite 重开，没有调用真实付费 API。接口契约见 [DeepSeek 官方搜索与抓取文档](https://api-docs.deepseek.com/zh-cn/guides/search/)。参考实现版权及许可见 [LICENSE.deepseek-harness](LICENSE.deepseek-harness)。
