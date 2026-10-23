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
- `packages/coding-agent/src/main.ts` 的 `import` 和 `export` 直接拒绝。`durable/import.ts`、`durable/export.ts`、`durable/runtime.ts`、`durable/bug-report.ts` 和 `durable/extension-events.ts` 已删除。`createDurableSession` 不再打开旧会话，调用会得到 `old_session_runtime_removed`。旧宿主的 `/share` 在没有替换写入器时拒绝导出。`packages/evals` 仍调用这个函数，因此现在会收到拒绝，还没有改成 Python SDK。
- `host/commands.ts`、`durable/tui.ts`、`durable/interactive.ts`、`durable/print.ts`、`modes/rpc/durable-rpc.ts` 已删除。产品 `cli.ts` 和 `main.ts` 到不了 `src/durable/`。宿主服务仍引用 `sessions`、`harness-setup`、`fork-management` 等模块，删除整目录仍未通过。产品 `cli.ts` 遇到内部进程角色、`web`、`server`、`client` 直接拒绝。`--session` 与 `import` / `export` 一样拒绝旧会话。
- 旧公证 DMG 文件 `.artifacts/python-backend-sign/python-desktop/AmazMe-macos-arm64.dmg` 没有改写，挂载后仍是当时的内容。展开的 `.app` 里 `node_modules/@amazme/coding-agent` 已从磁盘删除。新的桌面打包脚本不包含这个包。`desktop-current` 不含旧宿主，但签名改写了 Mach-O，服务启动失败。`desktop-boot/AmazMe-macos-arm64.dmg` 能启动，页面没有 `__AMAZME_BOOT__`，公证提交 `73a6e978-4364-415c-a319-0d0f6ddbda17`，钉住后 SHA256 `232e851afe15c8879cc7a6c6acec5697fa6d3c9ee24c7f0b24ed5916a42c33f0`，签名后 build_id `a561427495a15b41f35449d5124d81623b8ed3312daf7f082aca6b652f30b477`。`desktop-page/AmazMe-macos-arm64.dmg` 不含 coding-agent。签名后 build_id 是 `9f0cd59f1bd188016f2b17c609e6559a89ae0a443387d73a267a643962a6f914`。已签名应用 smoke 退出码 0，`__AMAZME_BOOT__` 的名字是 AmazMe，版本是 0.1.0，`server.id` 与就绪 `profile_id` 都是 `85280ea6ede093d413d2b126380ba757`，事件地址是 `ws://127.0.0.1:62967/api/v1/events`。公证 Accepted，提交 `80ff1888-7448-4eb3-82df-fd2ebb229359`。钉住后的 SHA256 是 `1c7a75c05235072fe1f7a5b03423cc421f804b232eb2d58e0f597437ce6d2600`。`desktop-quit/AmazMe-macos-arm64.dmg` 含关闭修复。签名后 build_id 是 `4197b4241dd1de0d14b1c7517b941261cafc6e73df5627ef1eacc697580522b1`。smoke 退出后监督器记录是 `stopped`。公证提交 `7f350709-2b6a-45ec-8971-a9c7d7f46263`，钉住后 SHA256 `2844f33971317cda73428cb52e0eec127796c919d6dee8e819e9b882b8a0cab7`。
- `@amazme/web` 的呈现、TUI 组件和受控 JS helper 不是旧业务内核。`@amazme/durable` 留在桌面包里，是因为页面壳的值导入还需要它，不是因为还要启动旧宿主。

删除要等这些剩余入口没有产品调用，并且替代路径已经通过。在那之前保持未通过。
