# @amazme/server

无界面的协议服务端与路由。通用核心只解释 `@amazme/protocol` 的信封、连接与路由，不导入 Durable 或业务服务；根入口不导入 Node 模块，也不监听 socket。具体传输把已接受的有序字节连接交给 `server.accept()`。

```typescript
import { Server, ServiceError, type ServerService } from "@amazme/server";

const service: ServerService = {
  call(call, context) {
    if (isAttach(call)) {
      context.attach(call.runtimeId); // 受控能力；结果里不返回路由
      return { attached: true };
    }
    throw new ServiceError("unknown_call", "unsupported call");
  },
};
const server = new Server({ serverId: "srv-1", service });
const unregister = server.registerRuntime("main", runtimeService);
const handlers = server.accept(byteConnection);
```

## 所有权

- 宿主拥有 `Server`、服务实现和注册的 runtime。`server.close()` 只停止接收并释放连接：中止已准入调用的 signal、关闭订阅，并等待这些调用结束；不会关闭或调用 runtime 背后的任何资源。调用的处理函数需要响应 signal，否则 `close()` 会一直等待它。
- 传输拥有监听器。每个被接受的 `ByteConnection` 从 `accept()` 起归服务端，直到服务端调用它的 `close()`；`send` 必须保序，它的 Promise 就是背压。传输把收到的字节、对端关闭和错误交给返回的处理函数。
- 连接拥有它的 request ID、订阅和 attachment。两个连接的同号 ID 互不影响。

## 路由与准入

握手前只接受 `hello`；版本不同回复 `unsupported_version`，其他首条消息回复 `protocol_error`，然后关闭。请求准入时检查完整 route：`serverId` 不符为 `wrong_server`；runtime route 必须等于本连接当前的 attachment，runtime 不同或尚未 attach 为 `not_attached`，attachment ID 不同为 `stale_attachment`。服务端只路由到 `registerRuntime` 显式注册的 runtime，客户端字符串不能指定其他目标。

attach / detach 的业务调用由宿主的 `ServerService` 实现。它通过 `ServerCallContext.attach(runtimeId)` / `detach()` 这项受控能力让路由器安装或移除 attachment：attachment ID 由服务端生成，路由器在这次调用的响应之前按序发布 `attachment` 信封，业务结果不需要也不应携带路由。重复 attach 同一个 runtime 保留原 attachment；切换、detach、注销 runtime 或断线后，旧 attachment 失效，其下的订阅关闭。连接关闭之后，已准入的 attach 无法再安装路由（`connection_closed`）；调用已经返回后再用这项能力或 `openSubscription` 会抛出 `call_settled`，保证信封总在响应之前。

## 调用、取消与订阅

处理函数收到不透明的 `call` 和 `CallContext`。抛出 `ServiceError` 会以它的 code 回复；其他异常回复 `internal`，细节只交给 `onError`。`cancel` 会中止匹配的同一 route 请求的 `context.signal`，断线和 `server.close()` 同样中止它；这只是 RPC 调用上下文，业务是否停止由服务自己决定。中止后的调用仍会回复，客户端忽略迟到的响应。重复的活动 request ID 视为协议错误并关闭连接。

`context.openSubscription(id)` 在调用的 route 下打开一个 `SubscriptionSink`。它在这次调用的成功响应排入发送队列之后才开始交付，调用失败则关闭；`send(update)` 在传输接受后 resolve `true`，已关闭则为 `false`。一条连接的更新一次只排一个进入发送队列，等待 `send` 就是背压；还在等待轮次的更新同样计入 `maxQueuedBytes`，不 await 地连续发送超过上限会关闭该连接。订阅的退订语义由服务自己定义，通常用 `context.subscription(id)?.close()`。

## 上限

| 选项 | 默认值 | 超限时 |
| --- | --- | --- |
| `limits` | 协议默认值 | 接收超限以 `protocol_error` 关闭连接 |
| `maxConnections` | 64 | `server_busy` 并关闭 |
| `maxActiveRequests` | 64（每连接） | 回复 `too_many_requests` |
| `maxSubscriptions` | 32（每连接） | `too_many_subscriptions` |
| `maxQueuedBytes` | 两帧（每连接） | 关闭该连接，不丢弃响应 |
| `handshakeTimeoutMs` | 10,000 | `handshake_timeout` 并关闭 |

`server.close()` 可重复调用并返回同一个 Promise；`onError` 自身的异常被忽略。

## 测试工具

`@amazme/server/testing` 提供内存字节连接：`memoryConnector(accept, options)` 返回可直接作为客户端 `transport` 的工厂。每个方向可以设置 `split`（如 `chunksOf(1)`）、`coalesce`、`delayMs` 和 `highWaterMark`：缓冲低于水位时 `send` 立即 resolve，所以多帧可以合并成一块投递；高于水位或 `pause()` 期间，`send` 要等字节真正送达，用来模拟对端停止读取。`destroy(error)` 模拟传输故障，`close()` 有序关闭；处理函数抛出的异常记录在 `handlerErrors`。所有字节都经过真实的编码与分帧。
