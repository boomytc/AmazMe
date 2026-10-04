# @amazme/client

无界面的协议客户端。只解释 `@amazme/protocol` 的信封、连接与路由，不导入 Durable 或任何业务服务；根入口不导入 Node 模块，也不打开 socket。具体传输由调用方注入有序字节接口。

```typescript
import { Client, type ByteTransportFactory } from "@amazme/client";

const transport: ByteTransportFactory = (handlers) => openOrderedByteStream(handlers);
const client = new Client({ serverId: "srv-1", transport });
await client.connect();
await client.request(client.serverRoute(), { your: "management call" });
const route = client.attachment; // server 发布的 runtime 路由
if (route) await client.request(route, { your: "runtime call" });
```

## 所有权

- 调用方拥有 `Client` 和传输工厂。每次 `connect()` 调用一次工厂，得到的 `ByteTransport` 归这次连接所有，直到客户端调用它的 `close()`；之后不应再触发处理函数。物理地址只属于工厂。
- `ByteTransport.send` 必须按调用顺序发送字节；它的 Promise 就是背压，客户端等前一块被接受后才发送下一块。`onClose` 和 `onError` 都是终态。
- 客户端只有一条当前连接。旧连接迟到的数据、关闭或错误一律忽略，不会改变新连接的状态。

## 握手与路由

`connect()` 先发送 `hello`，只有收到版本相同、`serverId` 等于构造参数的服务端 `hello` 才算连上。不同的 `serverId` 是 `server_mismatch`；`hello_error` 以服务端 code 作为 `RemoteError`；超时为 `handshake_timeout`。握手完成前的请求一律 `not_connected`。

服务端 route 是 `client.serverRoute()`。runtime route 只能来自服务端的 out-of-band `attachment` 信封，`client.attachment` 与 `onAttachmentChange` 反映它；业务结果不承载路由身份。服务端在 attach 调用的响应之前发布路由，所以那次请求 resolve 时 `attachment` 已经更新。切换、detach 或断线后旧路由失效，按旧路由的订阅随即结束。

## 请求、取消与订阅

request 与 subscription 的 ID 由每条连接各自编号。`request(route, call, { signal })` 返回不透明的 `result`，服务错误是带 code 的 `RemoteError`。中止 signal 会在本地立即拒绝并发送 `cancel`：这只取消这一次 RPC 的等待和服务端调用上下文，不是任何业务操作的取消。被取消的请求仍占着位置，直到服务端的响应到达；迟到的响应不会再次结算。没有对应请求的响应是协议错误，会关闭连接。

`subscribe(route, call, onUpdate, options)` 先在本地登记订阅，再发送 `call(subscriptionId)`，因此结果之前到达的更新也被保留。返回的 `initial` 是订阅调用的结果，调用方应先安装它，再调用 `start()` 按序交付期间缓冲的更新。`close()` 立即停止交付，并在路由仍有效时发送 `options.unsubscribe(id)`；重复调用等待同一次清理。`ended` 只 resolve 一次：`closed`、`detached` 或带错误的 `disconnected`。本地已取消、但服务端仍成功打开的订阅，会在迟到的成功响应到达后自动发送 unsubscribe。

## 断线

断线、`disconnect()` 或 `dispose()` 时，未完成的请求在本地确定拒绝，订阅结束，attachment 清空，传输关闭。已经被服务端接受的工作可能仍会在远端完成。客户端从不自动重连，也不重发请求：需要时再次 `connect()`、重新 attach，并只显式重复已知安全的操作。`disconnect()` 可重复调用；`dispose()` 之后不能再连接。

## 上限

| 选项 | 默认值 | 超限时 |
| --- | --- | --- |
| `limits` | 协议默认值 | 编码失败只拒绝该请求；接收超限关闭连接 |
| `maxPendingRequests` | 128 | 本地拒绝 `too_many_requests` |
| `maxSubscriptions` | 32 | 本地拒绝 `too_many_subscriptions` |
| `maxBufferedUpdates` | 64 | `start()` 之前缓冲超限，以 `subscription_overflow` 关闭连接 |
| `maxQueuedBytes` | 两帧 | 等待发送的字节超限，以 `send_overflow` 关闭连接 |
| `handshakeTimeoutMs` | 10,000 | `handshake_timeout` |

状态、attachment 与更新监听器抛出的错误交给 `onListenerError`，不会中断协议处理或清理。
