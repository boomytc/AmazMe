# 旧 TS 业务入口

这份清单只记录当前 `dev` 上谁还会执行旧业务运行时。它不是删除许可。呈现包、客户端运行时和受控 JS helper 继续保留。

## Python 内核

`backend/src` 没有 TypeScript 导入，也不拉起 `node` 上的旧 coding-agent。业务调用停在 Python Host、worker 和监督器。

## 产品入口不再打开旧运行时

`packages/coding-agent/src/main.ts` 的交互、`--print`、`--mode json` 和 `--mode rpc` 都走 Python。`AMAZME_DURABLE_TUI=1` 不会改这条路。测试在 `packages/coding-agent/test/durable-main-startup.test.ts`、`durable-default-main.test.ts`、`durable-rpc-main.test.ts`，以及构建后的 `dist/bundle/cli.js`（`python-entry-ignores-durable.test.ts`）。

`packages/gui/src/main.ts` 的 `boot` 只接受 `requirePythonBackend` 返回的可执行文件。没有 `AMAZME_PYTHON_BACKEND` 或包内 `amazme-backend` 时抛出「桌面需要包内的 Python 后端」，然后退出。它不再调用 `webHostLaunch` 或 `@amazme/coding-agent`。

`scripts/package-desktop.mjs` 的桌面闭包是 `@amazme/gui` 及其运行依赖（含页面用到的 `@amazme/web` 和 `@amazme/durable`），不包含 `@amazme/coding-agent`。`scripts/package-desktop.test.mjs` 锁住这份名单。

## 还不能删

- `packages/coding-agent/src/cli.ts` 的 `web`、`server` 和 `client` 直接拒绝，不再进入旧宿主。桌面安装包不再携带这个包。
- `packages/coding-agent/src/main.ts` 的 `import` 和 `export` 直接拒绝，不再调用 `durable/import.ts` 和 `durable/export.ts`。这两个模块仍被直接测试引用。
- `packages/coding-agent/src/durable/` 和 `host/commands.ts` 仍被直接测试引用。`test/support/legacy-durable-cli.ts` 和 `legacy-host-cli.ts` 只给这些测试启动旧会话或旧宿主，产品 `cli.js` 不调用它们。`cli.ts` 仍识别内部进程角色，用户命令到不了那里。
- 已经公证的桌面 DMG 仍是旧打包结果，里面还有 `@amazme/coding-agent`。当前打包脚本还没有拿去重新签名公证。
- `@amazme/web` 的呈现、TUI 组件和受控 JS helper 不是旧业务内核。`@amazme/durable` 留在桌面包里，是因为页面壳的值导入还需要它，不是因为还要启动旧宿主。

删除要等这些剩余入口没有产品调用，并且替代路径已经通过。在那之前保持未通过。
