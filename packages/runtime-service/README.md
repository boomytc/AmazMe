# @amazme/runtime-service

把 `@amazme/durable` 的 lane 控制与完整快照观察接到 `@amazme/protocol` 上。通用的 protocol、client、server 核心不导入本包。

| 入口 | 内容 | 依赖 |
| --- | --- | --- |
| `@amazme/runtime-service` | 纯契约：调用与 DTO 的 TypeBox schema、解析函数、错误码 | protocol 类型、TypeBox |
| `@amazme/runtime-service/client` | `RuntimeClient` / `RemoteLane`：基于 `@amazme/client` 的类型化调用 | 契约、client 类型；不加载 Durable 或 server |
| `@amazme/runtime-service/server` | `RuntimeHost`：绑定一个 `AgentHarness`；`createManagementService()`：attach / detach | Durable、server |

```typescript
// 服务端进程。当前 host 仍由调用方拥有 harness；交给 server 的 handle 在关闭时不能关掉这份 harness。
const harness = new AgentHarness(storage, { models, model });
const host = new RuntimeHost({ harness, lanes: ["main"] });
const server = new Server({
  serverId: "srv-1",
  service: createManagementService(),
  openRuntime: (runtimeId) => Promise.resolve(runtimeId === "main" ? {
    acquire: () => ({ service: host, release: () => undefined }),
    close: () => Promise.resolve(),
    idle: () => false,
  } : null),
});

// 客户端进程
const remote = new RuntimeClient(client);
await remote.attach("main");
const lane = remote.lane("main");
const { operationId } = await lane.accept({ kind: "prompt", text: "hello", operationId: "op-1" });
const watch = await lane.subscribe((snapshot) => render(snapshot));
await lane.drive(operationId);
const result = await lane.result(operationId);
```

## 契约

lane 调用都显式带 `lane`：`accept`、`drive`、`snapshot`、`result`、`steer`、`followUp`、`requestAbort`、`subscribe`；`unsubscribe` 按当前路由的 `subscriptionId` 退订。server route 上的管理调用只有 `attach { runtimeId }` 和 `detach`，结果是 `{ attached: true }` / `null`；路由身份由 server 的 `attachment` 信封发布。lane 是服务载荷，不是协议路由，`lanes` 可以限制可用 lane。lane 名和 `accept` 提供的新 operation ID 有固定的字符集和长度；`drive`、`result`、`requestAbort` 引用已存 ID，只要求非空且不含存储的保留分隔符 NUL，因而进程内准入的任意合法 ID 也能远程控制和查询。回复中的 ID 按 Durable 存储的原样返回，只要求非空。存储地址和命名空间由服务端构造。

服务端用 schema 校验全部请求，非法调用回复 `invalid_call`。客户端校验它实际消费的每个回复：admission、drive outcome、snapshot、result、steer / follow-up、abort 和 attach；快照的 lane、结果的 lane 和 operation ID、drive / abort 回复的 operation ID 也必须与请求相符。消息与内容块只校验 `role` / `type`，其余字段保持不透明，协议层已保证它们是严格 JSON。DTO 不包含内部 namespace、私有 `OperationState` 或执行函数；`phase` 只是阶段名，与 Durable 的 `LanePhase` 在编译期核对一致。Durable 的失败码原样作为服务错误码，例如 `lane_busy`、`operation_mismatch`。

## 执行与取消

- `accept` 保持 Durable 原有的持久化准入。调用方可以提供 `operationId`，确认丢失时用它查询 `result`；这不是恰好一次执行，也没有自动重试。
- `drive` 由 `RuntimeHost` 持有：它启动或加入 harness 的 drive，并独立追踪这个 Promise 的结束与错误（错误交给 `onError`）。RPC 只是等待它。取消这次等待（`cancelled`）、断线或 detach 都不会取消已准入的操作，harness 原有的 drive 合并与恢复行为不变。`snapshot` 与 `result` 从不启动 drive。
- `requestAbort` 是唯一的业务取消，它把取消请求持久化。RPC cancel、退订、detach、断线都不映射为它，也不会调用 harness 的 `close()` 或 `abandon()`。

## 观察

订阅返回完整快照，之后的每次更新也是完整快照，没有增量、Delta 或断线回放。服务端先注册 Storage 监听，再读取初始快照，因此两者之间的写入不会遗漏。初始快照作为订阅调用的结果返回；server 在传输接受这条响应之后才激活订阅并交付更新，客户端也先安装初始快照，再按序处理期间到达的更新。

Storage 监听器只置 dirty 并安排一次固定窗口（`publishWindowMs`，默认 16 ms）。窗口结束时读取前先消费 dirty，然后读一次快照、发送一次；读取或发送期间的新通知保留下来，结束后开启下一个窗口。这不是会被持续写入无限推迟的尾随 debounce：持续生成期间，更新按窗口加一次收发的节奏到达。同一条连接上的订阅轮流读取和发送，一次只有一份快照在途，初始响应也等待传输接受后才让下一份读取开始，多个大快照不会挤爆连接的发送上限。每个订阅最多只有一份正在处理的快照加一个 dirty 标记；慢客户端只会降低更新频率，不会阻塞 Storage 回调，也不会积压中间快照。

更新是 `{ kind: "snapshot", snapshot }` 或 `{ kind: "ended", code, message }`。服务端自己结束订阅时一定先发 `ended` 再关闭，不会静默停止：`runtime_closed`（host 关闭）、`snapshot_failed`（读取失败）、`snapshot_unavailable`（快照无法编码，例如超过帧上限）。客户端的 `ended` 只 resolve 一次，取值是本地 `closed`、`detached`、`disconnected`，或服务端的 `ended` 及其 code；不符合契约的更新以 `invalid_update` 结束并退订。快照超过 `maxFrameBytes` 时订阅无法继续，这是当前完整快照设计的已知上限。

版本是存储总 seq，其他 lane 的写入也会推进它，所以 version 跳号合法，也可能出现内容未变、版本更新的快照。去重按订阅进行：服务端不重复发送不比上次新的版本，客户端丢弃不比已安装快照新的更新。去重版本由客户端私有保存，修改返回 DTO 不会改变观察进度。重连后需要重新订阅并取得完整快照，不同 Storage 的版本不做比较。退订、detach 或断线后不再交付；进行中的交付会被等待并清理。

## 停机与所有权

调用方始终拥有 `AgentHarness` 和 `Storage`。上面的 handle 把 `close` 留成空操作，因此 server 的关闭不会碰到 harness。建议的停机顺序：

1. `await server.close()`：停止接收连接，中止已准入调用的等待并等它们结束，并关闭它打开的 handle；
2. `await host.close()`：之后的调用回复 `runtime_closed`，每个已初始化的订阅收到 `runtime_closed` 通知后关闭，尚未完成的订阅调用回复 `runtime_closed`；它等待进行中的初始和更新快照读取，不等停止读取的对端；
3. `await host.drivesSettled()`：等待本 host 启动或加入的 drive 结束，或者由宿主决定提前 `harness.abandon()`；
4. 由宿主调用 `harness.close()`。

host 和 server 都不会自行关闭 harness 或存储。未结算的操作在下一次显式 `drive` 时按 Durable 既有策略恢复，不自动重发模型请求。

## 范围

只覆盖无界面的控制与观察基础架构。没有业务客户端、TUI / WebUI、服务目录、插件 facets、增量日志或模型请求自动重发。
