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

`context.openSubscription(id)` 在调用的 route 下打开一个 `SubscriptionSink`。它在这次调用的成功响应被传输接受之后才开始交付，`ready` 此时 resolve `true`；调用失败或 sink 先关闭时为 `false`。服务可以用 `ready` 协调同一连接的初始响应背压，但调用本体须先返回初始结果。`send(update)` 在传输接受后 resolve `true`，已关闭则为 `false`；更新不是严格 JSON 或超过帧上限时 reject，什么也不发送，sink 保持打开，服务可以改发更小的通知或自行关闭。一条连接的更新一次只排一个进入发送队列，等待 `send` 就是背压；还在等待轮次的更新同样计入 `maxQueuedBytes`，不 await 地连续发送超过上限会关闭该连接。订阅的退订语义由服务自己定义，通常用 `context.subscription(id)?.close()`。

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

## Unix socket

`@amazme/server/unix` 是只在 Node 中使用的独立子入口：`listenUnix(server, { path })` 返回 `UnixListener`。它把每个接受的 socket 交给同一个 `server.accept()`，使用同样的协议、编码和分帧。

- 调用方显式提供物理路径，逻辑 `serverId` 与路径无关。
- 不存在的父目录按 0700 创建；调用方已有的目录不会被 chmod。socket 文件为 0600。
- 路径上已有文件或 socket 都会明确失败。连接探测被拒不能证明 socket 已失效，因此监听器不会探测或自动删除已有 socket；调用方应先确认原实例已结束并释放其路径。
- socket 先绑定在同目录下一个 0700 私有临时目录里，在那里 chmod 0600，再硬链接到目标路径。私有目录保留一份 `owned` 硬链接直到关闭清理结束，防止 inode 被回收重用；归属检查无需文件创建时间。硬链接不会覆盖已有文件；chmod 之前没有其他人能连上；libuv 关闭时按名字 unlink 的只是私有绑定名。临时路径比目标目录长约 22 个字符，选路径时要留出 socket 路径长度上限的余量。发布完成之前到达的连接会被直接关闭，不交给 server。成功关闭或绑定失败会删除私有目录。
- `close()` 可重复调用：停止接收，销毁仍打开的连接（server 会收到 `onClose`），然后只在路径仍是本实例那个 socket 时才删除它。路径已被替换时保留替换后的文件或 socket。
- 每条连接的写入保序并遵守 `drain`，未写出的字节受 `maxQueuedBytes`（默认 32 MiB）约束；服务端主动关闭时先写完已接受的字节再结束，超过 `closeTimeoutMs` 则销毁。对端关闭、错误、半帧 EOF 和监听失败都会释放资源。
- Windows 上调用会直接报告不支持。没有 TCP、WebSocket 或服务发现。

测试需要本地监听 Unix socket 的权限；受限沙箱中的 `EPERM` 属于环境限制，应在允许监听的环境中重跑。

## 测试工具

`@amazme/server/testing` 提供内存字节连接：`memoryConnector(accept, options)` 返回可直接作为客户端 `transport` 的工厂。每个方向可以设置 `split`（如 `chunksOf(1)`）、`coalesce`、`delayMs` 和 `highWaterMark`：缓冲低于水位时 `send` 立即 resolve，所以多帧可以合并成一块投递；高于水位或 `pause()` 期间，`send` 要等字节真正送达，用来模拟对端停止读取。`destroy(error)` 模拟传输故障，`close()` 有序关闭；处理函数抛出的异常记录在 `handlerErrors`。所有字节都经过真实的编码与分帧。
