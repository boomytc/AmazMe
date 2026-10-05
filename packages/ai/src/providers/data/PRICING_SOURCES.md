# 缓存价格来源

目录里的 `cost` 单位是美元 / 1,000,000 tokens，与 `cost.input` / `cost.output` 相同。下面只记录已经写入 `catalog.json` 的缓存价。核对日期是 **2026-10-05**。

未出现在下表的目录 id 没有写入 `cacheRead` 或 `cacheWrite`：官方页没有同一单位的价格，或 id 对不上。`google-vertex` 未使用 Gemini Developer API 的价格。

## Anthropic

- 定价页：https://platform.claude.com/docs/en/about-claude/pricing
- 同一张表也在：https://docs.anthropic.com/en/docs/about-claude/pricing
- 档位：标准价。`cacheRead` 取 Cache hits and refreshes。`cacheWrite` 取 **5 分钟写入价**，不取 1 小时写入价。
- 覆盖 `anthropic` 目录中这些 id：`claude-fable-5`、`claude-fable-5-1`、`claude-opus-5-5`、`claude-opus-5`、`claude-opus-4-8`、`claude-opus-4-7`、`claude-opus-4-6`、`claude-opus-4-5`、`claude-opus-4-5-20251101`、`claude-sonnet-5-5`、`claude-sonnet-5`、`claude-sonnet-4-6`、`claude-sonnet-4-5`、`claude-sonnet-4-5-20250929`、`claude-haiku-4-5`、`claude-haiku-4-5-20251001`。带日期的 id 是同一模型快照，沿用该模型行。
- `claude-sonnet-5-5`：命中 $0.20 / MTok，5 分钟写入 $2.50 / MTok。模型说明页 https://platform.claude.com/docs/en/models/sonnet-5-5/overview 与定价表一致。

## OpenAI

- 定价页：https://developers.openai.com/api/docs/pricing
- 档位：**Standard，短上下文**。有 `<272K` 与长上下文两列时，取与目录里现有 input/output 相同的短上下文列。`cacheRead` 是 Cached input。`cacheWrite` 只在 Cache writes 列给出数字时填写。
- 读写都有：`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。
- 只有 cacheRead：`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.4-nano`、`gpt-5.3-codex`（同页 Codex 表）、`gpt-5.2`、`gpt-5.1`、`gpt-5`、`gpt-5-mini`、`gpt-5-nano`、`gpt-4.1`、`gpt-4.1-mini`、`gpt-4.1-nano`、`gpt-4o`、`gpt-4o-mini`、`gpt-realtime-2.1`（Text 行）、`o1`、`o3`、`o4-mini`、`o3-mini`。
- 限时价：`gpt-5.6-sol` 的 Standard 短上下文价是促销价，官方页写明至少维持到 2026-11-21。

## Gemini

- 定价页：https://ai.google.dev/gemini-api/docs/pricing
- 档位：**付费 Standard**。`cacheRead` 取 Context caching 的按 token 读取价，不取按小时的 storage 价。有 prompts ≤200k / >200k 分档时，取 **≤200k**，与目录里现有 input 一致。只填了 `google`。
- 覆盖：`gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.5-flash-lite`、`gemini-3.1-pro-preview`、`gemini-3.1-pro-preview-customtools`、`gemini-3.1-flash-lite`、`gemini-3-flash-preview`、`gemini-2.5-pro`、`gemini-2.5-flash`、`gemini-2.5-flash-lite`。
- 限时价：`gemini-3.6-flash`、`gemini-3.7-flash`、`gemini-3.8-flash` 用的是 2026-12-31 前的价格。2027-01-01 起 input、output 和 context caching 读取价翻倍（cacheRead 从 0.075 变为 0.15）。
