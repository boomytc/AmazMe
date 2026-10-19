# 插件执行与重载

AmazMe 复用 Chord 的 facets 加载和资源生命周期、Durable 的执行注册表。插件通过进程内的 `AgentExtensions` 服务贡献工具、提示段、任务、钩子及包装器；会话继续使用同一个 Harness 和存储，没有插件专用执行器。

## 插件入口

包的 session facet 使用 `@amazme/coding-agent/plugin`，把注册租约交给 facet 清理：

```ts
import { Type } from "@amazme/ai";
import { activationFacet } from "@amazme/protocol/services";
import { AgentExtensions } from "@amazme/coding-agent/plugin";
import { defineExtension, defineTool } from "@amazme/durable";

export default activationFacet("example/session", [AgentExtensions], (services) => {
  const extensions = services.get(AgentExtensions);
  return extensions.install(defineExtension({
    name: "example",
    tools: [defineTool({
      name: "echo",
      description: "返回输入文字",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (args) => ({ output: [{ type: "text", text: args.text }] }),
    })],
  }));
});
```

扩展名称归插件所有，不得覆盖应用已安装的扩展。安装前使用真实注册表校验；候选版本的同名注册等待旧租约退出后生效。`list()` 返回实际注册表的名称和工具、提示段、任务名称。此服务只在进程内使用，不能通过客户端 RPC 安装代码。

## 命令与服务

`@amazme/coding-agent/plugin` 同时提供 `SlashCommands` 和 `AgentController`。命令使用同一份注册表，原生 TUI 和宿主都能消费。原生 TUI 显示命令与参数补全，按名称查找当前注册项后执行；应用自带命令不能被插件覆盖。

`prompt`、`steer` 和 `followUp` 可以传入稳定的 `requestId`，相同对话中的重试返回原提交，即使对话正在运行或曾经重启，也不会创建第二个输入。持久请求编号用于 `waitForPrompt` 和 `cancelPrompt`；`cancelPrompt` 只取消该输入所在的当前轮次，并等待其工具及所属工作清理。其他排队输入保留并继续，已结束的编号不会取消后来的轮次。同一轮次中已经放置的 steering 输入共享取消结果。

```ts
import { activationFacet } from "@amazme/protocol/services";
import { AgentController, SlashCommands } from "@amazme/coding-agent/plugin";

export default activationFacet("example/commands", [SlashCommands, AgentController], (services) => {
  const commands = services.get(SlashCommands);
  const agent = services.get(AgentController);
  return commands.replace({
    name: "explain",
    description: "解释指定内容",
    argumentHint: "<内容>",
    run: (args, context) => agent.prompt({ message: `解释：${args}`, images: null }, context),
  });
});
```

重载使用 `replace()` 暂存同名候选；旧注册退出后候选生效，候选失败则旧注册仍可执行。静态新注册可用 `register()`，名称重复时拒绝。两者均返回清理函数，由 `activationFacet` 返回给 Chord 资源所有者。多个租约在关闭时逆序释放，打开失败也必须清理已经取得的租约。

`AgentController` 提供 prompt、steer、followUp、取消排队、abort、compact 和等待结果。原生入口与宿主在每次调用时取得当前对话；宿主与 `AgentRuntime.current(context)` 共用焦点解析。取消排队只操作当前对话所属的输入，停止和压缩也使用该对话。传入 `conversationId` 的投递固定到指定对话，已准入操作和等待回执继续使用其原编号。命令异步等待时应传递收到的 `context` 并响应其取消信号；Esc 会取消当前命令及当前会话任务，关闭时先取消并等待命令退出，再关闭 Harness 和插件资源。

需要准入自定义持久任务的进程内插件可使用 `AgentRuntime.current(context)`，取得当前选中对话与现有 Harness。原生与 session worker 都提供该服务；后台任务准入后保持自己的对话归属，焦点切换不会迁移它。该服务使用 Chord 的 local opaque 成员，不发布到 RPC，也不创建另一套执行器。插件应通过普通所属任务、对话、提交和工具边界执行，并传递取消上下文。

修改对话级插件设置时使用 `AgentRuntime.withWritableConversation(change, context)`：Host 捕获一次当前对话，将短写入与归档准入串行处理，并检查加载状态和取消信号。`change` 接收该对话，只应提交短事务，不持有长网络请求或等待任务结束；不要从插件单独导入宿主的准入锁实现。

宿主的 `Models` 服务同样使用当前选中对话。模型与推理强度存于该对话的 `AgentDoc`，其他分叉保持各自配置；读取可用推理强度、循环和显式选择都以实际目标文档为准。选择模型同时沿用 Pi 的新会话默认设置保存行为，重启已有会话时仍恢复其持久配置。

自定义 Chord 服务使用 `remote()` / `local()` 契约、同步 `defineFacet(api => ...)` 和 `api.serve()`。工厂通过 `self.get()` 声明依赖，通过 `self.resource(name, declaration)`、`self.on(name, source, handler)` 管理资源和监听器，通过 `self.state(name, schema, initial, options)` 声明各自带版本及迁移函数的状态单元；调用取消与代际上下文由 `host.root()` 传递。远程契约必须用 `hostNamed()` 或 `hostFamily()` 声明位置；应用创建 Host 时提供 `self`，连接父宿主时提供 `principal`。`host.get()` 和 `ctx.get()` 等待状态就绪，界面需要同步引用时使用 `host.hold()`；`self.get()` 仍为同步声明，Chord 会在激活前等待其依赖。`self.state()` 也可用 `{ init(ctx) }` 从资源或依赖初始化首值。详见 [Chord 文档](../../chord/README.md)。

产品现有领域接口使用 `@amazme/protocol/services`：`remoteService<T>(名称, 方法参数个数表, 状态成员名)` 声明位置参数与 Context 契约，`localService<T>(名称)` 声明本机对象，`serviceFacet()` 创建并持有一个实现，`activationFacet()` 持有注册租约。依赖列表必须明确列出；框架直接调用 Chord Host、句柄和资源，不提供另一套 RPC 或热重载运行时。接口中最后一个 `Context` 不计入位置参数表。远程声明使用 `services:` 宿主族及输入中的 `host` 字段，`createServiceHost()` 创建对应宿主，`ServiceScope` 使用 `{ host }` 指定已连接的目标。公开方法与状态由 Chord 传输；本机对象不会进入远程目录。

完成检查可使用 `hook(GenerationTask, { onYield })`。最终响应先写入 Durable 检查点，再运行该钩子；检查期间关闭并重开会继续处理原响应。`api.commit()` 可更新插件文档或创建 `ownership: { kind: "task", taskId: api.taskId }` 的所属任务，回调返回 `undefined`；`api.waitForTask()` 等待其终态。检查失败可返回 `{ continue: "具体反馈" }`，沿用原输入继续；用户跟进或 reset 被最终边界选中时，既有队列策略优先。检查的次数上限、超时与结果属于插件自己的持久状态，不把模型的原始响应当成验证结果。

钩子的 `api.agent(context)` 返回实际解析后的模型、工具选择及工具元数据。现有 Web“改动前询问”策略除内建修改工具外，还识别插件工具的 `destructiveHint: true` 或 `readOnlyHint: false`，不会因新增工具名而漏掉已经选用的询问策略。

## 当前接线

- 宿主给 session worker 传入自己执行的注册表，现有选包、构建和 session facet 加载流程继续使用。
- 原生 Durable 运行时接受可选的 `facetLoader`，配置后才创建插件宿主。控制器的 `reload()` 与 TUI `/reload` 在空闲时重读提示资源，并重建已选插件；没有 loader 时只重读资源，不创建插件宿主。
- CLI、print、JSON、RPC 与 SDK 的扩展来源都是原生 facet。`-e <文件、包目录或 npm/git 来源>`、用户扩展目录、已信任项目的 `.amazme/extensions` 和显式路径走同一发现。`--no-extensions` 关闭发现，显式 `-e` 仍生效。这些入口不加载内联扩展工厂。

## 源码选择

单文件默认导出新版 Chord facet（例如 `defineFacet(...)` 或 `activationFacet(...)`），扩展目录也支持 `index.ts`/`index.js` 入口或直接放置的源码文件。包目录包含 `package.json`，session 入口默认为 `src/session.ts`，可用 `chord.facets.session` 指定或设为 `false`。包名称必填。原生入口只构建和加载 session，其他 facet 不会在这里运行。AmazMe 提供 AI、Chord、Durable、Protocol 和插件 API，普通包依赖仍由插件自行声明和安装。

用户 `settings.json` 的 `extensions` 路径相对用户 agent 目录；项目 `.amazme/settings.json` 的路径相对 `.amazme`，只在项目已信任时加载。本地路径和 glob 增加发现来源，`!pattern` 排除，`+path` 强制包含，`-path` 强制排除且优先于包含；精确包路径和它的 session 文件选择同一个模块。实际来源按规范路径去重，项目决定优先，显式 `-e` 强制包含。

`packages` 复用现有包管理器的安装位置、npm 版本检查、git 更新和项目优先规则。`amazme install <来源>` 保存声明；`-e npm:...` 或 `-e git:...` 使用已有临时安装位置。包对象的 `extensions` 过滤其 session 文件，空数组关闭加载；项目的 `autoload: false` 只应用匹配项的增减，并可沿用同名用户包安装。例如：

```json
{
  "packages": [{ "source": "npm:my-plugin@1.0.0", "extensions": ["src/session.ts"] }],
  "extensions": ["./plugins/*.ts", "!extensions/**/*.ts", "+extensions/keep.ts"]
}
```

包没有 session 时不会激活原生插件，也不会把 SDK 的 `pi.extensions` 工厂转接为 facet。包安装与资源文档见 [Packages](packages.md)。

随包交付的可选能力位于 `plugins/`：[history](../plugins/history/README.md) 提供原始文本检索、记录读取和 `/recall`；[memory](../plugins/memory/README.md) 提供 Markdown 项目记忆、`/memory` 和单独启用的后台候选捕获；[checkpoint](../plugins/checkpoint/README.md) 提供所选文件的字节快照、恢复预览、备份与回滚。显式安装或选择后才注册其工具和命令，默认会话不加载。

宿主还加载已选包的 `server` 角色，约定入口为 `src/server.ts`，可用 `chord.facets.server` 指定或关闭。服务和资源复用 Chord 及同一包 profile。`HostSessions` 只在宿主进程内提供 agent 目录和会话执行接口，不发布到远程服务目录，也不在原生或 worker 的 session 角色中提供。新增、移除或修改宿主包后重启宿主，运行中的会话保留自己的包选择。

[automation](../plugins/automation/README.md) 的调度执行代码位于该可选包内。未选中时没有调度服务或定时器；Web 从实际服务目录发现能力，启动及重连后显示相应入口。计划文件损坏时显示只读问题，修复后可从页面重新读取。

[verification](../plugins/verification/README.md) 通过完成钩子运行用户显式配置的命令检查，沿用普通工具任务与审批，保存独立结果并有限地请求修正。默认不启用；恢复复用原回答与检查，不自动重跑已中断的不安全命令。

[workflows](../plugins/workflows/README.md) 提供 JSON 阶段计划、独立上下文、有界后台并发、持久暂停/恢复和独立命令检查证据。`/workflows` 在原生和 Web 都调用同一工具任务；命令目录订阅实际注册与退役变化，插件命令直接执行，只有提示词模板和技能转换为模型输入。

[web](../plugins/web/README.md) 提供直连 DeepSeek 的 `web_search`、`web_fetch` 和 `/web`。默认不加载且 API 关闭；设置按对话保存，凭据来自现有 DeepSeek 配置。调用传递取消上下文、限制响应大小，重开后不自动重复已中断的付费请求。

[computer-use](../plugins/computer-use/README.md) 组合外部 `cua-driver` 和现有 TypeSafe 分类器，提供 `cu_observe`、`cu_locate`、`cu_act`、`cu_ground_and_act`。默认不加载且桌面控制关闭，由 `/computer-use` 修改对话策略；工具串行执行，原生动作与分类请求均不自动重放。二进制独立按需准备，macOS 可使用共享 `.app` 宿主及私有 socket，插件重载或会话关闭时释放 MCP 会话和子进程。

Computer-use 首版集成已于 2026-10-19 完成，已通过 macOS 受控场景的真实桌面与线上 Jev 联调，包括后台 AX 点击、赋值及使用补丁运行时的 Cocoa 自绘 Canvas 点击。跨平台和完整动作矩阵验收仍待补充，范围与清单见[集成验收记录](../plugins/computer-use/LIVE-VALIDATION.md)。

直接加载源码的原生入口通过 `/plugins` 和模型提示提供已选源码、当前安装中的 API 类型位置与本指南。宿主会话的模型提示使用同一 API 与指南，并列出该会话实际选中的 manifest；构建文件 `plugin.json` 按角色保存 ESM 代码，代码带内联 source map，可据其中的 `sources` 与 `sourceRoot` 定位原文件。修改原源码，不修改生成的 bundle；没有源码映射的产物需使用其配置的包源码位置。

修改后，在任务结束或取消时运行 `/reload`，会重新构建并加载候选版本，不要求先手工构建。修改包声明或来源选择后需重启，重载沿用本次启动选中的来源。没有选中插件时，不注册插件开发提示段或插件贡献的命令。

## 修改后生效

重载串行处理，只在会话任务结束或取消后进行。加载和切换期间拒绝新的模型操作。候选版本准备失败时，清理候选并保留旧版；切换完成后的清理失败可能使 Chord 宿主失效，此时拒绝继续运行，需重启会话。关闭会话先等待 Harness 结束工具调用，再关闭 Chord Host 并释放插件资源。临时导入文件在导入完成或失败后立即删除。

CLI 源码插件由重载入口重新构建；Web 的 `/reload` 先请求既有宿主构建服务重建当前会话选中的包，再由 worker 加载产物。构建失败时原版本继续可用，修复源码后可重试；活动任务需先结束或取消。重载期间切换会话不会把迟到的产物用于新会话。应用直接提供 manifest loader 时仍需先生成新的 facet 产物。Facet 名称、契约版本与输入遵循 Chord 的重载约束。服务接口变更必须同步修改消费者；产品协议版本为 11，Chord 链接协议为 4，不保留旧服务消息解析。浏览器构建、应用壳及内核源码仍有各自的构建与重启边界，不承诺所有源码热替换。

## 工具结果与嵌套调用

原生工具结果用 `output` 提供模型文字/图片、`structuredOutput` 提供程序数据、`details` 提供界面状态。返回结构化数据时声明 `structuredOutputSchema`。`api.executeTool(name, args, context, { key?, progress? })` 复用同一套校验、钩子、审批和所属任务规则；嵌套结果随父任务结束回收，显式稳定键可在安全重放的父任务恢复时重新附着。`callers` 进一步限定模型、工具或两者是否可调用注册项。
