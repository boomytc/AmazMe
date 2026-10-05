# 上下文与思考档位来源

`catalog.json` 不能写注释。这里记下这次按供应商文档改过、或核对后保持原值的字段。单位和目录字段相同：`contextWindow` 与 `maxTokens` 都是 token 数。没写在下面的目录 id 这次没有新的可引用页面，原值未改。

## DeepSeek

页面同时覆盖 `deepseek-flash` 和 `deepseek-v4-pro`。两个 id 都在 `deepseek` 预设里。

- 模型与价格，Model Details，CONTEXT LENGTH：1M。`contextWindow` 是 1000000。https://api-docs.deepseek.com/quick_start/pricing
- 同一页 MAX OUTPUT：MAXIMUM 384K。Chat Completions，Request，`max_tokens`：1 到 384K（393216）。`maxTokens` 是 393216。https://api-docs.deepseek.com/api/create-chat-completion
- 同一请求的 `model` 取值就是这两个 id。`thinking.type` 是 `enabled` 或 `disabled`。`reasoning_effort` 是 `none` | `low` | `high` | `max`。`minimal` 会被改写成 `low`，`medium` 和 `xhigh` 会被改写成 `high`。目录不发送会被改写的档。`off` 不带 effort。`thinkingSwitch` 是 `"thinking"`。https://api-docs.deepseek.com/guides/thinking_mode 的 Thinking Mode Toggle and Effort Control。

## MiniMax

只改了 `minimax` 预设。`minimax-cn` 用的是另一套主机，这次没有对上的页面。

- Anthropic SDK，Supported Models：`MiniMax-M3` 上下文 1,000,000，`MiniMax-M2.7` 与 `MiniMax-M2.7-highspeed` 上下文 204,800。https://platform.minimax.io/docs/api-reference/text-anthropic-api
- Messages API，CreateMessageReq，`max_tokens`：`MiniMax-M3` 最大 524288。其余模型最大 204800。https://platform.minimax.io/docs/api-reference/text-chat-anthropic
- Anthropic SDK，Thinking Control：M2.x 接受 `thinking.type` `disabled` 但忽略它，思考仍然开着。所以 `MiniMax-M2.7` 和 `MiniMax-M2.7-highspeed` 的 `thinkingLevelMap` 把 `off` 标成不支持。该页没有 `minimal`、`low`、`medium`、`high`，这四个键保持省略。`MiniMax-M3` 可以用 `disabled` 关掉、用 `adaptive` 打开。`adaptive` 不是现有思考档的名字，所以 M3 的 `thinkingLevelMap` 没写。
