# @amazme/gui

Electron 窗口。它拉起已安装 AmazMe CLI 的网页宿主，再把那个回环页面装进窗口。会话、工具和模型调用仍在宿主里，走同一套 durable，这里没有第二套界面，也没有第二套会话协议。右键菜单和出错弹框的中英文案用 `@amazme/web` 的 `desktop.*` 键（`./locale` 与 `./strings`），不另留一份目录。

做法对齐 deepseek-harness 的 `apps/desktop`：子进程跑产品自己的 web 命令，读到就绪行再 `loadURL`，窗口开 `contextIsolation`、`sandbox`、`nodeIntegration: false`。关窗口就结束宿主。桌面壳负责窗口和宿主生命周期，运行依赖由发布流程提供。

宿主入口通过应用依赖解析 `@amazme/coding-agent` 的已安装 CLI，运行 `amazme web`，不查找仓库或源码解析器。就绪行是宿主打印的 `Web: http://127.0.0.1:<port>/`。端口用 `0`，避免和已经开着的 `dev:web` 抢 4310；同一目录里若已有宿主，这条命令会附着上去，窗口看到的仍是那一份会话。子进程用系统 Node，不用 Electron 当 Node：宿主的会话 worker 会再执行 `process.execPath`，并且存储用 `node:sqlite`。

```bash
npm run build --workspace @amazme/web
npm run build --workspace @amazme/coding-agent
npm run build --workspace @amazme/gui
npm start --workspace @amazme/gui
```

壳的 typecheck 和构建解析 `@amazme/web/locale` 与 `@amazme/web/strings` 的 dist。根 `build` / `build:offline` 先构建 Web 与 coding-agent，再构建 GUI。单独启动这个包之前，两者的 dist 要已经在。

需要 Node.js 22.19 或更新版本，以及随产品发布的模型目录数据。宿主默认使用启动进程的当前目录。经 npm 启动时沿用 npm 记录的初始工作目录；项目目录可显式指定。要打开别的项目目录时设置 `AMAZME_GUI_CWD`。`AMAZME_GUI_NODE` 可指定跑宿主的 Node。

`npm test` 检查就绪行和拉起参数。`npm run test:smoke` 在有显示的环境里真正打开窗口并核对启动清单。

正式发布的网页脚本由 coding-agent 构建预先生成，宿主、worker 与客户端共享编译模块和同一持久状态。桌面依赖声明包括 coding-agent；Electron 作为桌面壳运行环境，宿主使用系统 Node 22.19+。

已通过独立安装产物的真实窗口启动、同宿主状态查询和 Web 同步验证；`AMAZME_GUI_CWD` 指定实际项目，`INIT_CWD` 保留 npm 的原启动位置。开发目录和源码解析器不参与已安装桌面的宿主启动。
