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

## 当前接线

- 宿主给 session worker 传入自己执行的注册表，现有选包、构建和 session facet 加载流程继续使用。
- 原生 Durable 运行时接受可选的 `facetLoader`，配置后才创建插件宿主并提供 `reloadPlugins()`；TUI 的 `/reload` 调用该入口。没有 loader 时不创建插件宿主。
- 普通 CLI 的插件选择和自动发现仍需接线；当前原生验证通过 `openDurable({ facetLoader })` 的实际运行时入口完成，不能当作普通 CLI 已加载插件。

## 修改后生效

重载串行处理，只在会话任务结束或取消后进行。加载和切换期间拒绝新的模型操作。候选版本准备失败时，清理候选并保留旧版；切换完成后的清理失败可能使 Chord 宿主失效，此时拒绝继续运行，需重启会话。关闭会话先等待 Harness 结束工具调用，再释放插件资源和加载产物。

源码插件需先构建新的 facet 产物，再调用重载。Facet ID 和服务形状沿用 Chord 的重载约束。浏览器构建、应用壳及内核源码仍有各自的构建与重启边界，不承诺所有源码热替换。
