# @amazme/gui

Electron 窗口。它拉起已安装 AmazMe CLI 的网页宿主，再把那个回环页面装进窗口。会话、工具和模型调用仍在宿主里，走同一套 durable，这里没有第二套界面，也没有第二套会话协议。右键菜单和出错弹框的中英文案用 `@amazme/web` 的 `desktop.*` 键（`./locale` 与 `./strings`），不另留一份目录。

窗口图标与 macOS Dock 图标使用 Web 包的 `dist/page/app-icon.png`，网页标签使用同源 SVG favicon，并提供 32 像素 PNG 备用。图标沿用界面里的 AM 像素标记，资源随 Web 包构建复制，不依赖运行时生成。

macOS 启动时在 `~/Library/Caches/AmazMe/desktop` 中缓存独立的 `AmazMe.app`，使用 AmazMe 的应用名称、标识和 ICNS 图标，确保 Dock 悬停与应用菜单显示正确名称。缓存应用绑定当前安装目录的桌面入口与系统 Node，退出后也能从 Dock 重新打开；没有指定工作目录时从用户主目录启动。它不是可独立移动的安装包。Electron、Node 路径或图标、启动脚本更新后重新生成；共享的 Electron 安装不被修改。Linux 和 Windows 沿用 Electron 的标准启动方式。

做法对齐 deepseek-harness 的 `apps/desktop`：子进程跑产品自己的 web 命令，读到就绪行再 `loadURL`，窗口开 `contextIsolation`、`sandbox`、`nodeIntegration: false`。

关闭主窗口默认只隐藏窗口，网页宿主和运行中的会话继续工作；托盘图标用 `assets/tray-icon.png` 恢复窗口，托盘菜单、应用菜单和 `Cmd/Ctrl+Q` 的退出共用一个确认框。托盘创建失败时退回原来的行为：关闭窗口即结束宿主。桌面壳负责窗口和宿主生命周期，运行依赖由发布流程提供。

项目创建和编辑支持多个源文件夹。“添加文件夹”使用原生目录选择器，preload 只暴露这一项选择能力，主进程核对当前窗口、主页面和宿主地址后返回所选路径。项目保存、授权、会话执行目录与 Web 共用宿主服务。

宿主入口通过应用依赖解析 `@amazme/coding-agent` 的已安装 CLI，运行 `amazme web`，不查找仓库或源码解析器。就绪行是宿主打印的 `Web: http://127.0.0.1:<port>/`。端口用 `0`，避免和已经开着的 `dev:web` 抢 4310；同一目录里若已有宿主，这条命令会附着上去，窗口看到的仍是那一份会话。子进程用系统 Node，不用 Electron 当 Node：宿主的会话 worker 会再执行 `process.execPath`，并且存储用 `node:sqlite`。

```bash
npm run dev:desktop
```

该命令按 package manifest 计算并顺序构建 GUI 的 workspace 依赖闭包，覆盖源码中的构建期 workspace 依赖。AI 使用 `build:offline`，已有模型数据不会被刷新；缺数据时先显式运行 `npm run hydrate:model-data`。可用 `node scripts/build-workspace-dependencies.mjs @amazme/gui --plan` 查看构建顺序。

桌面通过 `@amazme/coding-agent/config` 复用 profile 路径归一化，不复制一套 CLI 配置路径规则。

菜单和错误框优先使用当前页面的 `lang`，页面未就绪、已崩溃或语言读取超时时使用同一 profile 的全局 `locale` 设置（与 `SettingsManager.getLocalePreference` 一致，不读项目覆盖）；`auto` 才跟随系统。程序生成的英文错误留在有界详情中，摘要按错误类型、退出码和超时参数本地化。

桌面拥有的 Web 子进程通过 stdin 管道观察父进程；正常关闭也用 EOF 请求跨平台的普通清理，强制升级只针对直属 Web PID，不杀可能被其他宿主接管的子树。即使 Electron 被 SIGKILL、无法执行退出钩子，EOF 仍触发普通宿主关闭。只关闭该次创建的宿主；附着已有宿主时不关闭共享后端。Web 子进程本身被 SIGKILL 时，端口由操作系统释放，空闲 worker 在 orphan-demand 宽限后退出（默认 30 秒），有未结束 Harness 任务时继续持久工作；不批量杀 Node。

壳的 typecheck 和构建解析 `@amazme/web/locale` 与 `@amazme/web/strings` 的 dist。根 `build` / `build:offline` 先构建 Web 与 coding-agent，再构建 GUI。单独启动这个包之前，两者的 dist 要已经在。

需要 Node.js 22.19 或更新版本，以及随产品发布的模型目录数据。宿主默认使用启动进程的当前目录。经 npm 启动时沿用 npm 记录的初始工作目录；项目目录可显式指定。要打开别的项目目录时设置 `AMAZME_GUI_CWD`。`AMAZME_GUI_NODE` 可指定跑宿主的 Node。`AMAZME_GUI_SESSION` 用会话 id 打开指定会话：桌面把 `?session=` 加到宿主 URL 上，页面优先于本窗口记忆与宿主保存的选择，且不会改写共享的选择文件。

`npm test` 检查就绪行、拉起参数、语言和错误合同；不含真实窗口 smoke。构建后用 `npm run test:smoke --workspace @amazme/gui` 在有显示的环境里单独验证真实窗口、退出与强制终止。smoke 使用临时 Electron/profile/server 目录，不读取用户凭据。

正式发布的网页脚本由 coding-agent 构建预先生成，宿主、worker 与客户端共享编译模块和同一持久状态。桌面依赖声明包括 coding-agent；Electron 作为桌面壳运行环境，宿主使用系统 Node 22.19+。

已通过独立安装产物的真实窗口启动、同宿主状态查询和 Web 同步验证；`AMAZME_GUI_CWD` 指定实际项目，`INIT_CWD` 保留 npm 的原启动位置。开发目录和源码解析器不参与已安装桌面的宿主启动。
