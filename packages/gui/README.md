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

## 确认后更新

签名安装默认每天检查稳定版，可在“软件更新”菜单手动检查、关闭自动检查或切换预览渠道。检查只获取清单，用户确认后才下载；下载显示进度并可取消。校验通过后仍需单独确认“安装并重启”，“稍后”不会在普通退出时偷偷替换应用。开发/ad-hoc 安装、只读 DMG、App Translocation 或不可写目录会停止自动安装，不请求管理员权限。

清单与 CLI/TUI 共用版本、URL 和 SHA256 合同。桌面额外要求精确版本的 macOS/架构/大小元数据；逐次重定向仅允许 GitHub HTTPS 与其 Release CDN。流式下载和落盘文件都核对 SHA256，挂载后及复制暂存后重新验证代码签名、Gatekeeper、bundle ID、真实版本和架构。发布者 Team ID 来自已验证的当前安装，不取自 manifest、下载内容或普通环境变量；DMG 必须有有效 staple，不要求 app 单独已有 staple。

安装前宿主通过仅主进程持有的能力令牌冻结新任务入口，并检查活动/排队/后台任务、终端与认证操作。忙碌时推迟安装。helper 使用单实例锁，等待正常宿主关闭和旧应用 PID 退出后才在同卷重命名替换；新桌面与宿主连接成功才确认健康。旧应用保留在相邻隐藏更新目录的 `Previous.app`，启动失败时尝试恢复；若新进程不能安全停止，保留两份副本并记录 `recovery-required`，不强行覆盖运行中的应用。二进制回滚不回滚用户数据，后续数据迁移必须保持回退兼容。

`AMAZME_GUI_USER_DATA_DIR` 可选定独立桌面 profile；更新重启沿用原 profile 和宿主数据目录。真实验收使用隔离目录，绝不替换用户正在使用的应用。

更新锁先完整写入并 fsync 所有者记录，再原子获取；重复启动不会截断已有锁。普通启动遇到活跃或未知锁立即退出，不留下占用应用 PID 的模态框。持锁 helper 崩溃后，启动进程取得 Electron 单例，再检查私有 job、所有者 PID 已退出、当前应用的 Apple 信任/发布者/版本和旧版本 hash，才恢复启动并清理已知失效锁；未知记录保留，恢复不会自动继续安装或移动应用。

`.github/workflows/trusted-desktop.yml` 仅手动触发，复用现有 release 环境凭证，只输出签名/公证 artifact，不创建 tag 或 Release。目标 DMG 与较低版本的合成基线分别经过真实公证、staple、Gatekeeper 与隔离安装测试；合成基线只改变 GUI 包版本，用来验证安装器，不代表旧正式产品兼容性。Release HTTPS 清单/重定向故障由精确 mocks 覆盖；artifact 安装验收不等于线上 Release 端到端验收。

## DMG 与 GitHub Release

在独立包基础上加 `--dmg` 会生成 `AmazMe-<version>-macos-<arch>.dmg` 与同名 `.sha256`：DMG 内含应用和“应用程序”快捷方式，创建后会挂载回读 `release-manifest.json` 校验版本。推送 `v<version>` 标签触发 `.github/workflows/release.yml`，在 macOS runner 上构建、验证并创建 GitHub Release；标签必须与 `packages/gui/package.json` 的版本一致。

签名分两种，都走同一套由内向外的签名流程：

- 本地和 CI 预览不带参数，用 ad-hoc 签名，不开 hardened runtime：ad-hoc 没有团队 ID，开了库校验会拒绝加载自带的 Electron 框架。其他机器首次打开会被 Gatekeeper 拦截。
- 发布同时传 `--keychain <钥匙串> --team-id <团队 ID>`，从该钥匙串里选出这个团队唯一的 Developer ID Application 身份，带 hardened runtime 和 `packages/gui/assets/entitlements.mac.plist` 里的权限签应用和 DMG，签完核对 TeamIdentifier。随后 `scripts/notarize-macos.mjs` 提交公证、staple，并用 `codesign --verify --deep --strict` 和 `spctl` 复核后重写 `.sha256`。

release 工作流在 `release` 环境里运行：证书只给导入证书那一步，App Store Connect 密钥只给公证那一步；临时钥匙串和密钥文件放在 `$RUNNER_TEMP`，最后一步无论成败都会删掉。团队 ID 取仓库变量 `APPLE_TEAM_ID`。

公证提交前会离线解析未加密的 PKCS#8 `.p8`，提前发现字面量 `\n`、整段 base64 或损坏的私钥文本；这不验证密钥对应的账户权限。Invalid 结果只在 submission ID 为有效 UUID 时读取日志，并转换为固定的签名、hardened runtime、时间戳或 entitlements 提示。公证提交与日志读取的原始输出、日志路径和任意响应字段不会回显；读取诊断失败也保持公证失败，不会继续 staple。

## 独立预览包

`scripts/package-desktop.mjs` 生成可移动的 macOS 预览应用：宿主、运行时闭包和固定版本的官方 Node 一起放进 `AmazMe.app`，启动脚本只引用 `Contents/Resources` 内的路径。用官方 Node 压缩包，不要用 Homebrew 的 Node——后者链接共享的 `libnode`，复制单个二进制会在移动后启动失败；脚本会用 `otool` 拒绝这种二进制。

```bash
# 官方 Node 22.19+ 的 darwin tarball 解压后
node scripts/package-desktop.mjs --node /path/to/node-v22.23.3-darwin-arm64/bin/node --out /tmp/AmazMe --verify
```

`--verify` 会把应用复制到临时目录，清掉 `AMAZME_GUI_NODE` 和 PATH 里的 Node，再跑一次 smoke；只有宿主用包内 Node 启动并回报 `desktop smoke:` 才算通过。产物内的 `Contents/Resources/release-manifest.json` 记录应用版本、Electron、Node 与各内部包版本，发布说明以应用版本为准。

当前限制：ad-hoc 预览包只适合内部使用，对外分发以 GitHub Release 上公证过的 DMG 为准。产品包统一使用同一个发布版本（以根目录 `package.json` 为准，发布记录见 [GitHub Releases](https://github.com/boomytc/AmazMe/releases)），应用显示、安装包与发布清单一致；`release-manifest.json` 记录实际组合，便于回查。

已通过独立安装产物的真实窗口启动、同宿主状态查询和 Web 同步验证；`AMAZME_GUI_CWD` 指定实际项目，`INIT_CWD` 保留 npm 的原启动位置。开发目录和源码解析器不参与已安装桌面的宿主启动。
