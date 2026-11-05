# @amazme/codemode

AmazMe 个人源码环境使用的私有 QuickJS helper workspace，不发布 npm 包，不维护云端部署或打包入口。

Python Supervisor 通过 `backend/src/amazme_backend/execution/codemode/helper.mjs` 启动独立 Node 进程。helper 使用 `InlineCodemodeSandbox` 和依赖中的 QuickJS WASM 执行脚本，通过私有 IPC 回调 Python 工具；进程、取消、超时与输出归属由 Python 执行层管理。Node 路径必须由启动器通过 `AMAZME_NODE` 显式传入。

脚本只能调用注入的 `tools`，不直接获得本机文件、网络或进程权限。工具调用继续经过原会话的审批和副作用账本。脚本失败、取消或进程结果未确认时，不提交 `store` 变更。

## 源码编译

在仓库根目录执行：

```bash
npm run build --workspace @amazme/codemode
```

编译会先清理该 workspace 的 `dist`，避免删除源码后残留旧模块。`dist` 是本机运行产物，不是分发包。

## helper 使用的接口

```ts
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@amazme/codemode";

const sandbox = new InlineCodemodeSandbox({
    wasm: loadQuickJSWasm(),
    tools: [],
    timeoutMs: 5000,
});
try {
    const result = await sandbox.execute('text(6 * 7)', { store: {} });
    // result.ok 决定是否可提交 result.storeWrites；失败时保留原状态。
} finally {
    await sandbox.close();
}
```

实际集成以 Python helper 源码为准。`source` 和 `declarations` 子入口提供脚本选项解析及工具声明生成；根入口保留本机 QuickJS 类型、脚本结果和执行能力。它们不拥有产品会话或持久状态。

脚本输出受字符数和条目数限制，存储写入也有单值和总量限制；具体上限以 `src/runtime/prelude-source.ts` 为准。Python 侧另有脚本长度、超时和内存预算，以 `execution/codemode/runtime.py` 为准。

源码沿用 Pi 的 MIT 许可证和版权归属，见仓库根目录 `LICENSE` 与 `UPSTREAM.md`。
