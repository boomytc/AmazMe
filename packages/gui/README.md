# @amazme/gui

Electron 窗口。它拉起仓库里已经有的网页宿主，再把那个回环页面装进窗口。会话、工具和模型调用仍在宿主里，走同一套 durable，这里没有第二套界面，也没有第二套会话协议。右键菜单和出错弹框的中英文案用 `@amazme/web` 的 `desktop.*` 键（`./locale` 与 `./strings`），不另留一份目录。

做法对齐 deepseek-harness 的 `apps/desktop`：子进程跑产品自己的 web 命令，读到就绪行再 `loadURL`，窗口开 `contextIsolation`、`sandbox`、`nodeIntegration: false`。关窗口就结束宿主。安装包、自动更新和托盘不在这个切片里。

宿主入口与 `scripts/dev-web.mjs` 相同（实验切片的 `web` 命令，经 source resolver 跑源码）。就绪行是宿主打印的 `Web: http://127.0.0.1:<port>/`。端口用 `0`，避免和已经开着的 `dev:web` 抢 4310；同一目录里若已有宿主，这条命令会附着上去，窗口看到的仍是那一份会话。子进程用系统 Node，不用 Electron 当 Node：宿主的会话 worker 会再执行 `process.execPath`，并且存储用 `node:sqlite`。

```bash
npm run build --workspace @amazme/gui
npm start --workspace @amazme/gui
```

需要 Node.js 22.19 或更新版本，以及 `dev:web` 同样依赖的模型目录数据（`npm run build` 会生成）。`npm start` 由 npm 把当前目录改到这个包，所以宿主的工作目录默认是仓库根，与 `npm run dev:web` 一致。要打开别的项目目录时设置 `AMAZME_GUI_CWD`。`AMAZME_GUI_NODE` 可指定跑宿主的 Node。

`npm test` 检查就绪行和拉起参数。`npm run test:smoke` 在有显示的环境里真正打开窗口并核对启动清单。
