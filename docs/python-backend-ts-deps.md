# 旧 TS 业务入口

这份清单只记录当前 `dev` 上谁还会执行旧业务运行时。它不是删除许可。呈现包、客户端运行时和受控 JS helper 继续保留。

## Python 内核

`backend/src` 没有 TypeScript 导入，也不拉起 `node` 上的旧 coding-agent。业务调用停在 Python Host、worker 和监督器。

## 仍会进入旧运行时的路径

`packages/coding-agent/src/main.ts` 在 `AMAZME_DURABLE_TUI=1` 时才加载：

- `./durable/interactive.ts` 的 `runDurableInteractive`
- `./modes/rpc/durable-rpc.ts` 的 `runDurableRpc`
- `./durable/print.ts` 的 `runDurablePrint`

该变量未设置时，交互走 `runOwnedPythonInteractive` 或 `runPythonSessionTui`，`--print`、`--mode json` 和 `--mode rpc` 走 `runPythonHeadless`。这个变量不在用户帮助里，现有测试还用它打开旧界面。

`packages/gui/src/main.ts` 只有在 `resolvePythonBackend` 找不到 `AMAZME_PYTHON_BACKEND` 或包内 `amazme-backend` 时，才用 `packages/gui/src/launch.ts` 的 `webHostLaunch` 去跑 `@amazme/coding-agent` 的 `bundle/cli.js`。指定了 Python 后端的桌面启动不走这条。

## 还不能删

- `packages/coding-agent/src/durable/` 和 `modes/rpc/durable-rpc.ts` 仍被上面的环境变量和对应测试引用。
- 桌面端在没有 Python 后端时仍会启动旧 Node 宿主。
- `@amazme/web` 的呈现、TUI 组件和受控 JS helper 不是旧业务内核。

删除要等默认安装产物不再调用这些入口，并且替代路径已经通过。在那之前保持未通过。
