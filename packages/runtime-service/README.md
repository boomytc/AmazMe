# @amazme/runtime-service

把 `@amazme/durable` 的 lane 控制与完整快照观察接到 `@amazme/protocol` 上。通用的 protocol、client、server 核心不导入本包。

| 入口 | 内容 | 依赖 |
| --- | --- | --- |
| `@amazme/runtime-service` | 纯契约：调用与 DTO 的 TypeBox schema、解析函数、错误码 | protocol 类型、TypeBox |
| `@amazme/runtime-service/client` | `RuntimeClient` / `RemoteLane`：类型化调用，含 `remove` | 契约、client 类型；不加载 Durable、server 或 Node |
| `@amazme/runtime-service/server` | `openOwnedRuntimes()`：宿主打开并持有 runtime；`createManagementService()`：attach / detach / remove | Durable、server；不加载 Node |
| `@amazme/runtime-service/jsonl` | `openJsonlRuntime()`：用排他文件锁打开一份 JSONL | server 类型、Durable 的 Node JSONL 入口 |

`RuntimeClient.conversations()` 返回这份 runtime 里已经写下的 lane 名。它不创建 lane，也不读取别的文件。`RemoteLane.configure()` 读取或更换该 lane 的模型和思考级别。`RemoteLane.fork()` 在这份日志里打开另一段对话。

```typescript
import { Server } from "@amazme/server";
import { openJsonlRuntime } from "@amazme/runtime-service/jsonl";
import { createManagementService, openOwnedRuntimes } from "@amazme/runtime-service/server";

let server: Server;
server = new Server({
  serverId: "srv-1",
  service: createManagementService({ removeRuntime: (runtimeId) => server.removeRuntime(runtimeId) }),
  openRuntime: openOwnedRuntimes({
    open: (runtimeId) => runtimeId === "main"
      ? openJsonlRuntime("./state/main.jsonl", { models, model })
      : Promise.resolve(null),
  }),
});

const remote = new RuntimeClient(client);
await remote.attach("main");
const lane = remote.lane("main");
const { operationId } = await lane.accept({ kind: "prompt", text: "hello", operationId: "op-1" });
const watch = await lane.subscribe((snapshot) => render(snapshot));
await lane.drive(operationId);
const result = await lane.result(operationId);
```

`open` 只收到宿主自己的 runtime id 和打开信号。它读取存储并创建 harness，不调用模型或工具。客户端不能提供路径或构造参数。返回给 server 的 handle 不暴露可写的 harness 或 storage。

## 契约

lane 调用都显式带 `lane`：`accept`、`drive`、`snapshot`、`history`、`result`、`steer`、`followUp`、`requestAbort`、`subscribe`；`unsubscribe` 按当前路由的 `subscriptionId` 退订。server route 上的管理调用是 `attach { runtimeId }`、`detach` 和 `remove { runtimeId }`。attach 的结果是 `{ attached: true }`，detach 和 remove 的结果是 `null`。路由身份由 server 的 `attachment` 信封发布。lane 是服务载荷，不是协议路由，`lanes` 可以限制可用 lane。lane 名和 `accept` 提供的新 operation ID 有固定的字符集和长度；`drive`、`result`、`requestAbort` 引用已存 ID，只要求非空且不含存储的保留分隔符 NUL。回复中的 ID 按 Durable 存储的原样返回，只要求非空。存储地址和命名空间由服务端构造。

服务端用 schema 校验全部请求，非法调用回复 `invalid_call`。没有接上 `removeRuntime` 时，`remove` 也是 `invalid_call`。客户端校验它实际消费的每个回复。消息与内容块只校验 `role` / `type`，其余字段保持不透明。DTO 不包含内部 namespace、私有 `OperationState`、执行函数或实例代际。`phase` 只是阶段名，与 Durable 的 `LanePhase` 在编译期核对一致。Durable 的失败码原样作为服务错误码。文件锁被占用时打开失败的码是 `storage_busy`。

## 执行与取消

- `accept` 保持 Durable 原有的持久化准入。调用方可以提供 `operationId`，确认丢失时用它查询 `result`；这不是恰好一次执行，也没有自动重试。
- `drive` 加入 harness 已有的 drive。RPC 只是等待它。取消这次等待（`cancelled`）、断线或 detach 都不会取消已准入的操作，也不会自动再次 drive。`snapshot` 与 `result` 从不启动 drive。持久化的 `retry_wait` 不是运行中的 Promise。
- `requestAbort` 是唯一的业务取消，它把取消请求持久化。RPC cancel、退订、detach、断线都不映射为它。

## 观察

`snapshot()` 返回完整祖先链和当前 `tools`。这一帧放不下时，调用失败，码是 `snapshot_unavailable`，连接保持。`history(before, limit)` 按页读取更早的祖先：`before` 是客户端已有的最旧条目，`null` 表示从最新的一条往前。回复是 `{ entries, older, skipped }`。单条放不进一帧的条目计入 `skipped`，不把连接关掉。

订阅返回的是有界窗口，不是整份祖先链。服务端先注册 Storage 监听，再读取初始快照，因此两者之间的写入不会遗漏。初始窗口作为订阅调用的结果返回；server 在传输接受这条响应之后才激活订阅并交付更新。客户端先安装初始窗口，再按序处理期间到达的更新。窗口里的 `entries` 是放得进这一帧的最新后缀。`omitted` 是更早、仍可用 `history` 读取的条数。`skipped` 是单条就放不进一帧的条数。`pendingOmitted` 表示未结算回复被留在帧外。状态、阶段、`tools` 和 `activity` 每次都在窗口里。

`activity` 不是 Durable 的私有操作状态，也不含 `pendingApprovals`。服务端直接读 `usage()` 和 `laneStatus()`，原样放进 `activity.usage`、`notBefore`、`retryReason`、`compacting`、`turnStartedAt`。`hitRate`、`cost` 和 `reasoning` 用 Durable 给出的值，不在这里重算。`reasoning` 是 `number | null`，不另加进 `output`。一轮的 `cost` 与 `usageCost` 的返回值同形；累计的 `cost` 每一项都可以是 null。审批等待不是重试，那时 `retryReason` 为 null。`branch` 和 `sessionStartedAt` 来自宿主的 `clock`。

Storage 监听器只置 dirty 并安排一次固定窗口（`publishWindowMs`，默认 16 ms）。窗口结束时读取前先消费 dirty，然后读一次快照、裁成一帧、发送一次；读取或发送期间的新通知保留下来，结束后开启下一个窗口。这不是会被持续写入无限推迟的尾随 debounce：持续生成期间，更新按窗口加一次收发的节奏到达。同一条连接上的订阅轮流读取和发送，一次只有一份快照在途。每个订阅最多只有一份正在处理的快照加一个 dirty 标记；慢客户端只会降低更新频率。

更新是 `{ kind: "advance", advance }` 或 `{ kind: "ended", code, message }`。服务端自己结束订阅时一定先发 `ended` 再关闭：`runtime_closed`（runtime 开始关闭）、`snapshot_failed`（读取失败）、`snapshot_unavailable`（连窗口头部都放不进一帧）。客户端的 `ended` 只 resolve 一次。一条过大的 transcript 不会再因为整份快照超限而结束订阅。

版本是存储总 seq，其他 lane 的写入也会推进它。去重按订阅进行。重连后需要重新订阅。退订、detach 或断线后不再交付。

## 停机与所有权

宿主创建 harness 和存储，并一直持有写入权，直到关闭成功之后的 `release` 或 `remove`。server 在没有 attachment、没有准入调用、且 `idle()` 为真时回收 runtime：关闭并 `release()`，不删数据。回收之后的 attach 会重新打开，旧 attachment 失效。正在运行的 drive、工具或已准入的存储操作让 `idle()` 为假，最后一个客户端离开也不会提前关闭它们或放锁。

`close("drain")` 立刻停止新的准入并结束订阅，然后等待 harness 排空已准入的 drive、工具、帧写入和存储操作，再关闭存储。它不中止模型或工具，也不写入 `requestAbort`。`close("abort")` 额外中止 harness 信号；进行中的 drain 会被后到的 abort 升级，后到的 drain 不会撤销 abort。两者共享同一次关闭，失败可以再试。不响应 abort 的工具会让这次关闭一直等待；在它返回之前不关闭存储、不删数据、不放锁。

观察立即停止交付，但退订清理失败时仍保留该观察方，之后的关闭会重试解除监听；成功清理的观察方不会重复处理。harness 的存储排空临时失败时也允许重试，失败期间不会关闭存储或释放写入权。

`release()` 在排空并关闭存储之后解开写入权，不删数据。`remove()` 在同样的排空之后删除这一实例的数据，然后才解开写入权。写入权已经通过 `release()` 放开时，再 `remove()` 会失败，不会删除可能属于新实例的文件。重复的关闭、释放和删除共享同一次操作；失败不会报成成功。多个清理步骤里有一个失败时，其余步骤仍会执行，错误汇总后抛出。不要在存储回调里等待关闭、释放或删除。

管理调用 `remove(id)` 不要求 runtime 此刻有打开的槽位：尚未打开或已闲置回收时，server 通过同一个受控工厂重新取得所有权后删除。因此进程重启后也能直接移除数据，不需要先 attach，也不会隐式 drive。

建议的进程停机是 `await server.close()`。它会排空并释放每个打开的 runtime，不删除数据。删除用 `server.removeRuntime(id)` 或客户端的 `remove`。未结算的操作在下一次显式 `drive` 时按 Durable 既有策略恢复，打开和重连都不重发模型请求。

## 范围

只覆盖无界面的控制、观察和这一进程内的 runtime 所有权。本包不含页面。本机控制端和 `127.0.0.1` 桥在 `@amazme/coding-agent`。没有服务目录、插件、逐 token 事件流、请求超时、自动重试或模型请求自动重发。JSONL 锁只覆盖本机本地文件系统，规则与 `@amazme/durable` 的 `openJsonlOwner` 相同。
