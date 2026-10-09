# 插件执行与重载

AmazMe 复用 Chord 的 facets 加载和资源生命周期、Durable 的执行注册表。插件通过进程内的 `AgentExtensions` 服务贡献工具、提示段、任务、钩子及包装器；会话继续使用同一个 Harness 和存储，没有插件专用执行器。

## 插件入口

包的 session facet 使用 `@amazme/coding-agent/plugin`，把注册租约交给 facet 清理：

```ts
import { Type } from "@amazme/ai";
import { defineFacet } from "@amazme/chord";
import { AgentExtensions } from "@amazme/coding-agent/plugin";
import { defineExtension, defineTool } from "@amazme/durable";

export default defineFacet({
  id: "example/session",
  setup(env) {
    const extensions = env.use(AgentExtensions);
    env.onActivate(() => {
      env.own(extensions.install(defineExtension({
        name: "example",
        tools: [defineTool({
          name: "echo",
          description: "返回输入文字",
          parameters: Type.Object({ text: Type.String() }),
          execute: async (args) => ({ content: [{ type: "text", text: args.text }] }),
        })],
      })));
    });
  },
});
```

扩展名称归插件所有，不得覆盖应用已安装的扩展。安装前使用真实注册表校验；候选版本的同名注册等待旧租约退出后生效。`list()` 返回实际注册表的名称和工具、提示段、任务名称。此服务只在进程内使用，不能通过客户端 RPC 安装代码。

## 命令与服务

`@amazme/coding-agent/plugin` 同时提供 `SlashCommands` 和 `AgentController`。命令使用同一份注册表，原生 TUI 和宿主都能消费。原生 TUI 显示命令与参数补全，按名称查找当前注册项后执行；应用自带命令不能被插件覆盖。

`prompt`、`steer` 和 `followUp` 可以传入稳定的 `requestId`，相同对话中的重试返回原提交，即使对话正在运行或曾经重启，也不会创建第二个输入。持久请求编号用于 `waitForPrompt` 和 `cancelPrompt`；`cancelPrompt` 只取消该输入所在的当前轮次，并等待其工具及所属工作清理。其他排队输入保留并继续，已结束的编号不会取消后来的轮次。同一轮次中已经放置的 steering 输入共享取消结果。

```ts
import { defineFacet } from "@amazme/chord";
import { AgentController, SlashCommands } from "@amazme/coding-agent/plugin";

export default defineFacet({
  id: "example/commands",
  setup(env) {
    const commands = env.use(SlashCommands);
    const agent = env.use(AgentController);
    env.onActivate(() => {
      env.own(commands.replace({
        name: "explain",
        description: "解释指定内容",
        argumentHint: "<内容>",
        run: (args, context) => agent.prompt({ message: `解释：${args}`, images: null }, context),
      }));
    });
  },
});
```

重载使用 `replace()` 暂存同名候选；旧注册退出后候选生效，候选失败则旧注册仍可执行。静态新注册可用 `register()`，名称重复时拒绝。两者均返回需要交给 `env.own()` 的清理函数。

`AgentController` 提供 prompt、steer、followUp、取消排队、abort、compact 和等待结果。原生入口与宿主在每次调用时取得当前对话；宿主与 `AgentRuntime.current(context)` 共用焦点解析。取消排队只操作当前对话所属的输入，停止和压缩也使用该对话。传入 `conversationId` 的投递固定到指定对话，已准入操作和等待回执继续使用其原编号。命令异步等待时应传递收到的 `context` 并响应其取消信号；Esc 会取消当前命令及当前会话任务，关闭时先取消并等待命令退出，再关闭 Harness 和插件资源。

需要准入自定义持久任务的进程内插件可使用 `AgentRuntime.current(context)`，取得当前选中对话与现有 Harness。原生与 session worker 都提供该服务；后台任务准入后保持自己的对话归属，焦点切换不会迁移它。该服务为 `{ local: true }`，不发布到 RPC，也不创建另一套执行器。插件应通过普通所属任务、对话、提交和工具边界执行，并传递取消上下文。

宿主的 `Models` 服务同样使用当前选中对话。模型与推理强度存于该对话的 `AgentDoc`，其他分叉保持各自配置；读取可用推理强度、循环和显式选择都以实际目标文档为准。选择模型同时沿用 Pi 的新会话默认设置保存行为，重启已有会话时仍恢复其持久配置。

自定义服务直接使用 Chord 的 `defineService()`、`env.provide()` 和 `env.use()`，进程内服务指定 `{ local: true }`。提供者和消费者使用各自 facet，资源仍由其 `env.own()`/生命周期回调清理；不需要额外的插件服务容器。

完成检查可使用 `hook(GenerationTask, { onYield })`。最终响应先写入 Durable 检查点，再运行该钩子；检查期间关闭并重开会继续处理原响应。`api.commit()` 可更新插件文档或创建 `ownership: { kind: "task", taskId: api.taskId }` 的所属任务，回调返回 `undefined`；`api.waitForTask()` 等待其终态。检查失败可返回 `{ continue: "具体反馈" }`，沿用原输入继续；用户跟进或 reset 被最终边界选中时，既有队列策略优先。检查的次数上限、超时与结果属于插件自己的持久状态，不把模型的原始响应当成验证结果。

钩子的 `api.agent(context)` 返回实际解析后的模型、工具选择及工具元数据。现有 Web“改动前询问”策略除内建修改工具外，还识别插件工具的 `destructiveHint: true` 或 `readOnlyHint: false`，不会因新增工具名而漏掉已经选用的询问策略。

## 当前接线

- 宿主给 session worker 传入自己执行的注册表，现有选包、构建和 session facet 加载流程继续使用。
- 原生 Durable 运行时接受可选的 `facetLoader`，配置后才创建插件宿主并提供 `reloadPlugins()`；TUI 的 `/reload` 调用该入口。没有 loader 时不创建插件宿主。
- 默认 CLI 的 `-e <文件、包目录或 npm/git 来源>` 加载原生 facet 插件；也发现用户扩展目录与已信任项目的 `.amazme/extensions`。`--no-extensions` 关闭发现，显式 `-e` 仍生效。原生路径不加载 SDK 扩展工厂；Print/RPC 继续使用其 SDK 扩展入口。

## 源码选择

单文件导出 `defineFacet(...)`，扩展目录也支持 `index.ts`/`index.js` 入口或直接放置的源码文件。包目录包含 `package.json`，session 入口默认为 `src/session.ts`，可用 `chord.facets.session` 指定或设为 `false`。包名称和版本必填。原生入口只检查和构建 session，其他 facet 不会在这里运行。AmazMe 提供 AI、Chord、Durable 和插件 API，普通包依赖仍由插件自行声明和安装。

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

`/plugins` 显示已选源码、当前安装中的 API 类型位置与本指南。模型提示中也包含相同信息。修改这些源码后，在任务结束或取消时运行 `/reload`，会重新构建并加载候选版本，不要求先手工构建。修改包声明或来源选择后需重启，重载沿用本次启动选中的来源。没有选中插件时不创建插件宿主，也不提供插件命令。

## 修改后生效

重载串行处理，只在会话任务结束或取消后进行。加载和切换期间拒绝新的模型操作。候选版本准备失败时，清理候选并保留旧版；切换完成后的清理失败可能使 Chord 宿主失效，此时拒绝继续运行，需重启会话。关闭会话先等待 Harness 结束工具调用，再释放插件资源和加载产物。

CLI 源码插件由重载入口重新构建；Web 的 `/reload` 先请求既有宿主构建服务重建当前会话选中的包，再由 worker 加载产物。构建失败时原版本继续可用，修复源码后可重试；活动任务需先结束或取消。重载期间切换会话不会把迟到的产物用于新会话。应用直接提供 manifest loader 时仍需先生成新的 facet 产物。Facet ID 和服务形状沿用 Chord 的重载约束。浏览器构建、应用壳及内核源码仍有各自的构建与重启边界，不承诺所有源码热替换。
