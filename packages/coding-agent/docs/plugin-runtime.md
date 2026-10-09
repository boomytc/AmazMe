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
- 默认 CLI 的 `-e <文件或包目录>` 加载原生 facet 插件；也发现用户扩展目录与已信任项目的 `.amazme/extensions`。`--no-extensions` 关闭发现，显式 `-e` 仍生效。原生路径不加载 SDK 扩展工厂；Print/RPC 继续使用其 SDK 扩展入口。

## 源码选择

单文件导出 `defineFacet(...)`，扩展目录也支持 `index.ts`/`index.js` 入口或直接放置的源码文件。包目录包含 `package.json`，session 入口默认为 `src/session.ts`，可用 `chord.facets.session` 指定。包名称和版本必填。AmazMe 提供 AI、Chord、Durable 和插件 API，普通包依赖仍由插件自行声明和安装。

用户 `settings.json` 的 `extensions` 路径相对用户 agent 目录；项目 `.amazme/settings.json` 的路径相对 `.amazme`，只在项目已信任时加载。目前原生设置选择精确本地路径，其他选择规则继续完善。

`/plugins` 显示已选源码、当前安装中的 API 类型位置与本指南。模型提示中也包含相同信息。修改这些源码后，在任务结束或取消时运行 `/reload`，会重新构建并加载候选版本，不要求先手工构建。没有选中插件时不创建插件宿主，也不提供插件命令。

## 修改后生效

重载串行处理，只在会话任务结束或取消后进行。加载和切换期间拒绝新的模型操作。候选版本准备失败时，清理候选并保留旧版；切换完成后的清理失败可能使 Chord 宿主失效，此时拒绝继续运行，需重启会话。关闭会话先等待 Harness 结束工具调用，再释放插件资源和加载产物。

CLI 源码插件由重载入口重新构建；应用提供的 manifest loader 则需先生成新的 facet 产物。Facet ID 和服务形状沿用 Chord 的重载约束。浏览器构建、应用壳及内核源码仍有各自的构建与重启边界，不承诺所有源码热替换。
