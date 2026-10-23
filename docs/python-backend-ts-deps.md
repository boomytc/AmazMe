# 旧 TS 业务入口

这份清单只记录当前 `dev` 上谁还会执行旧业务运行时。它不是删除许可。呈现包、客户端运行时和受控 JS helper 继续保留。

## Python 内核

`backend/src` 没有 TypeScript 导入，也不拉起 `node` 上的旧 coding-agent。业务调用停在 Python Host、worker 和监督器。

## 产品入口不再打开旧运行时

`packages/coding-agent/src/main.ts` 的交互、`--print`、`--mode json` 和 `--mode rpc` 都走 Python。`AMAZME_DURABLE_TUI=1` 不会改这条路。测试在 `packages/coding-agent/test/durable-main-startup.test.ts`、`durable-default-main.test.ts`、`durable-rpc-main.test.ts`，以及构建后的 `dist/bundle/cli.js`（`python-entry-ignores-durable.test.ts`）。

`packages/gui/src/main.ts` 的 `boot` 只接受 `requirePythonBackend` 返回的可执行文件。没有 `AMAZME_PYTHON_BACKEND` 或包内 `amazme-backend` 时抛出「桌面需要包内的 Python 后端」，然后退出。它不再调用 `webHostLaunch` 或 `@amazme/coding-agent`。

`scripts/package-desktop.mjs` 的桌面闭包是 `@amazme/gui` 及其运行依赖（含页面用到的 `@amazme/web` 和 `@amazme/durable`），不包含 `@amazme/coding-agent`。`scripts/package-desktop.test.mjs` 锁住这份名单。

## 还不能删

- `packages/coding-agent/src/cli.ts` 仍能执行 `web`、`server` 和 `client`。这不是桌面或默认 TUI 的启动路径，桌面安装包也不再携带这个包。
- `packages/coding-agent/src/main.ts` 的 `import` 和 `export` 子命令仍调用 `durable/import.ts` 和 `durable/export.ts`。
- `packages/coding-agent/src/durable/` 仍被上面的子命令和直接测试引用。测试里的 `test/support/legacy-durable-cli.ts` 只给这些测试启动旧会话，产品 `cli.js` 不调用它。
- 已经公证的桌面 DMG 仍是旧打包结果，里面还有 `@amazme/coding-agent`。当前打包脚本还没有拿去重新签名公证。
- `@amazme/web` 的呈现、TUI 组件和受控 JS helper 不是旧业务内核。`@amazme/durable` 留在桌面包里，是因为页面壳的值导入还需要它，不是因为还要启动旧宿主。

删除要等这些剩余入口没有产品调用，并且替代路径已经通过。在那之前保持未通过。
