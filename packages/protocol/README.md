# @amazme/protocol

运行时中立的路由信封、严格 JSON、CBOR 编解码与字节流分帧。根入口只使用 `Uint8Array`、`DataView`、`TextEncoder`、`TextDecoder`，不导入 Node 模块，也不依赖 AmazMe 的 AI、Agent、Durable、MCP、telemetry 或 coding-agent。唯一依赖是固定版本的 `typebox@1.3.27`，用于信封 schema。

本包只拥有路由与传输边界。`call`、`result`、`update` 是不透明的严格 JSON：协议只检查它们是 JSON，服务命令、快照、订阅和 lane 的含义由上层服务适配器校验和解释。协议不导出 prompt、lane 快照、操作状态或存储地址等业务结构。

## 消息

协议版本 `PROTOCOL_VERSION` 为 `2`，握手要求精确相等，没有协商或降级。快照带必填的 `activity`，旧客户端应在握手时收到 `unsupported_version`。

| 方向 | `type` | 内容 |
| --- | --- | --- |
| 客户端 | `hello` | `version`，必须是第一条消息 |
| 客户端 | `request` | `id`、`route`、不透明 `call` |
| 客户端 | `cancel` | `id`、`route`，取消一次请求的等待与调用上下文 |
| 服务端 | `hello` | `version`、逻辑 `serverId` |
| 服务端 | `hello_error` | 错误体，随后关闭连接 |
| 服务端 | `response` | `id` 与 `ok: true` 加可选 `result`，或 `ok: false` 加错误体 |
| 服务端 | `service_update` | `subscriptionId`、不透明 `update` |
| 服务端 | `attachment` | 当前连接的 runtime 路由，或 detach 后的 `null` |

路由分两种：`{ serverId }` 指向逻辑 server 本身；`{ serverId, runtimeId, attachmentId }` 指向显式注册的 runtime，并带上 server 为这条连接生成的 attachment。三者分别是逻辑 server 身份、runtime 身份和连接 attachment 身份，都不是物理地址。ID 为 1 到 128 个字符的 `[A-Za-z0-9][A-Za-z0-9._:-]*`。错误体是 `{ code, message }`：`code` 非空，形如 `route_mismatch`；`message` 最长 4096 个 UTF-16 单元。`errorBody()` 会替换孤立代理项并截断。

所有信封拒绝未知字段。request 与 subscription 的 ID 只在一条连接内有意义。

## 严格 JSON

`assertJsonValue()` / `isJsonValue()` 只接受 `null`、布尔、有限数字、不含孤立代理项的字符串、稠密的普通数组，以及原型为 `Object.prototype` 或 `null`、只有可枚举字符串数据属性的对象。`undefined`、`NaN`、无穷、BigInt、函数、symbol、稀疏数组或带额外键的数组、类实例、`Date`、`Map`、`Uint8Array`、访问器属性、不可枚举属性、symbol 键和循环引用都会失败。校验不转换类型、不填默认值，也不复制。编码前先做 JSON 检查再做 schema 检查，所以 schema 不会触发访问器。

## 编码与分帧

每帧是四字节无符号大端长度加一个 definite-length CBOR item。CBOR 只覆盖 JSON 需要的范围：`null`、布尔、安全整数、float64、文本、数组、文本键 map。超出安全范围的整数作为精确的 float64 传输。解码拒绝 tag、字节串、不定长、`undefined`、半精度与单精度浮点、非有限浮点、非文本 map 键、重复键、非法 UTF-8、尾随字节与截断。

`ClientMessageDecoder` / `ServerMessageDecoder` 接受任意分片和粘包。缓冲按实际收到的字节增长，不按声明长度预分配；长度头超过上限时在第四个字节到达时立即失败。空帧、`end()` 时停在帧中间、CBOR 或信封错误都会抛出 `ProtocolError`，解码器随即进入失败状态，之后的 `push` 和 `end` 都失败，不会再交出消息。同一块数据里排在错误之前的消息也随这次失败一起丢弃。

| 上限 | 默认值 |
| --- | --- |
| `maxFrameBytes` | 16 MiB，CBOR 载荷字节数，不含四字节长度头 |
| `maxDepth` | 64 层嵌套容器 |
| `maxItems` | 1,000,000 个数组元素与 map 条目合计，共享子树每次出现都计数 |

两端应配置相同的上限。公开的 CBOR 编码入口同样校验严格 JSON、深度和元素上限；CBOR 与分帧入口都会拒绝非法上限配置。编码在超过字节上限时立即停止，即使值由共享子树构成也不会无界展开；超限字符串会在分配 UTF-8 缓冲之前被拒绝。

`@amazme/protocol/writer` 提供 client 与 server 共用的 `FrameWriter`：按入队顺序逐帧等待传输背压，并限制未发送字节。该子入口只处理字节，不解释连接、路由或业务内容；根入口不导出它。

## 检查

```bash
npm run check:core
node --import tsx --test packages/protocol/test/*.test.ts
```

CBOR、分帧与严格 JSON 检查参考了 Pi 的实现，相关部分的 MIT 许可见 `NOTICE`。
