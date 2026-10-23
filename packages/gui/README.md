# @amazme/gui

Electron 窗口。它只拉起包内的 Python 后端，再把那个回环页面装进窗口。没有 Python 后端时启动失败，不回退到旧的网页宿主。右键菜单和出错弹框的中英文案用 `@amazme/web` 的 `desktop.*` 键（`./locale` 与 `./strings`），不另留一份目录。

窗口图标与 macOS Dock 图标使用 Web 包的 `dist/page/app-icon.png`，网页标签使用同源 SVG favicon，并提供 32 像素 PNG 备用。图标沿用界面里的 AM 像素标记，资源随 Web 包构建复制，不依赖运行时生成。

macOS 启动时在 `~/Library/Caches/AmazMe/desktop` 中缓存独立的 `AmazMe.app`，使用 AmazMe 的应用名称、标识和 ICNS 图标，确保 Dock 悬停与应用菜单显示正确名称。缓存应用绑定当前安装目录的桌面入口与系统 Node，退出后也能从 Dock 重新打开；没有指定工作目录时从用户主目录启动。它不是可独立移动的安装包。Electron、Node 路径或图标、启动脚本更新后重新生成；共享的 Electron 安装不被修改。Linux 和 Windows 沿用 Electron 的标准启动方式。

子进程跑包内的 `amazme-backend`，读到就绪行再 `loadURL`，窗口开 `contextIsolation`、`sandbox`、`nodeIntegration: false`。

关闭主窗口默认只隐藏窗口，网页宿主和运行中的会话继续工作；托盘图标用 `assets/tray-icon.png` 恢复窗口，托盘菜单、应用菜单和 `Cmd/Ctrl+Q` 的退出共用一个确认框。托盘创建失败时退回原来的行为：关闭窗口即结束宿主。桌面壳负责窗口和宿主生命周期，运行依赖由发布流程提供。

项目创建和编辑支持多个源文件夹。“添加文件夹”使用原生目录选择器，preload 只暴露这一项选择能力，主进程核对当前窗口、主页面和宿主地址后返回所选路径。项目保存、授权、会话执行目录与 Web 共用宿主服务。

桌面启动解析 `AMAZME_PYTHON_BACKEND`，否则使用 `Contents/Resources/amazme-backend/amazme-backend`。两者都没有时进程报错退出。就绪行是 Python 后端打印的 JSON。页面地址写明宿主、会话和工作区。

```bash
npm run dev:desktop
```

该命令按 package manifest 计算并顺序构建 GUI 的 workspace 依赖闭包，覆盖源码中的构建期 workspace 依赖。AI 使用 `build:offline`，已有模型数据不会被刷新；缺数据时先显式运行 `npm run hydrate:model-data`。可用 `node scripts/build-workspace-dependencies.mjs @amazme/gui --plan` 查看构建顺序。

界面语言仍读取 `AMAZME_CODING_AGENT_DIR` 或 `~/.amazme/agent/settings.json`。桌面包自己解析这个路径，不加载旧宿主。

菜单和错误框优先使用当前页面的 `lang`，页面未就绪、已崩溃或语言读取超时时使用同一 profile 的全局 `locale` 设置（与 `SettingsManager.getLocalePreference` 一致，不读项目覆盖）；`auto` 才跟随系统。程序生成的英文错误留在有界详情中，摘要按错误类型、退出码和超时参数本地化。

桌面拥有的 Python 后端在显式退出时停止。关掉窗口不取消共享后台工作。子进程没有父进程 stdin 管道。

壳的 typecheck 和构建解析 `@amazme/web/locale` 与 `@amazme/web/strings` 的 dist。单独启动这个包之前，Web 的 dist 要已经在。桌面运行时不再依赖 `@amazme/coding-agent`。

需要 Node.js 22.19 或更新版本来构建窗口。业务宿主是包内的 Python 后端。项目目录可显式指定，设置 `AMAZME_GUI_CWD`。`AMAZME_GUI_SESSION` 用会话 id 打开指定会话，地址里同时写上宿主和工作区。

`npm test` 检查 Python 启动合同、语言和错误合同；不含真实窗口 smoke。构建后用 `npm run test:smoke --workspace @amazme/gui` 验证没有 Python 后端时真实 Electron 进程会拒绝启动。smoke 使用临时目录，不读取用户凭据。

Electron 是窗口壳。正式安装包带上 Python 后端后才打开页面。更新辅助程序仍使用包内 Node。

## 确认后更新

签名安装默认每天检查稳定版，可在“软件更新”菜单手动检查、关闭自动检查或切换预览渠道。检查只获取清单，用户确认后才下载；下载显示进度并可取消。校验通过后仍需单独确认“安装并重启”，“稍后”不会在普通退出时偷偷替换应用。开发/ad-hoc 安装、只读 DMG、App Translocation 或不可写目录会停止自动安装，不请求管理员权限。

清单与 CLI/TUI 共用版本、URL 和 SHA256 合同。桌面额外要求精确版本的 macOS/架构/大小元数据；逐次重定向仅允许 GitHub HTTPS 与其 Release CDN。流式下载和落盘文件都核对 SHA256，挂载后及复制暂存后重新验证代码签名、Gatekeeper、bundle ID、真实版本和架构。发布者 Team ID 来自已验证的当前安装，不取自 manifest、下载内容或普通环境变量；DMG 必须有有效 staple，不要求 app 单独已有 staple。

安装前宿主通过仅主进程持有的能力令牌冻结新任务入口，并检查活动/排队/后台任务、终端与认证操作。忙碌时推迟安装。helper 使用单实例锁，等待正常宿主关闭和旧应用 PID 退出后才在同卷重命名替换；新桌面与宿主连接成功才确认健康。旧应用保留在相邻隐藏更新目录的 `Previous.app`，启动失败时尝试恢复；若新进程不能安全停止，保留两份副本并记录 `recovery-required`，不强行覆盖运行中的应用。二进制回滚不回滚用户数据，后续数据迁移必须保持回退兼容。

`AMAZME_GUI_USER_DATA_DIR` 可选定独立桌面 profile；更新重启沿用原 profile 和宿主数据目录。真实验收使用隔离目录，绝不替换用户正在使用的应用。

更新锁先完整写入并 fsync 所有者记录，再原子获取；重复启动不会截断已有锁。普通启动遇到活跃或未知锁立即退出，不留下占用应用 PID 的模态框。持锁 helper 崩溃后，启动进程取得 Electron 单例，再检查私有锁中的完整 job 快照、所有者 PID 已退出、当前应用的 Apple 信任/发布者/版本和旧版本 hash，才恢复启动并清理已知失效锁；未知记录保留，恢复不会自动继续安装或移动应用。恢复元数据不依赖准备目录存在。GUI 退出仅删除未交接的暂存；任何锁、旧应用副本或已开始的事务日志都会保留该目录，由安装/恢复流程接管清理。

`npm run release -- --acceptance` 在发布前额外做可信更新验收，加 `--dry-run` 时只输出签名/公证产物，不创建 tag 或 Release。目标 DMG 与较低版本的合成基线分别经过真实公证、staple、Gatekeeper 与隔离安装测试；合成基线只改变 GUI 包版本，用来验证安装器，不代表旧正式产品兼容性。Release HTTPS 清单/重定向故障由精确 mocks 覆盖；artifact 安装验收不等于线上 Release 端到端验收。

## DMG 与 GitHub Release

1.0.0 之前不打 `v*` 标签，也不上传 GitHub Release。没有明确要求发布时，两者都不做。这个阶段只做本地验证和本地构建；`npm run release` 会拒绝低于 1.0.0 的版本。签名、公证、标签和上传留到 1.0.0，并且一次完成。本地 `dist-release/v*` 只保留正在构建的那一个应用版本，旧应用版本目录在下一次构建开始时删除。`dist-release/computer-use/` 是独立组件的构建与验证目录，由 computer-use 维护命令管理，应用发布不会删除它。

在独立包基础上加 `--dmg` 会生成 `AmazMe-<version>-macos-<arch>.dmg` 与同名 `.sha256`：DMG 内含应用和“应用程序”快捷方式，创建后会挂载回读 `release-manifest.json` 校验版本。

仓库没有 GitHub 工作流。1.0.0 起，发布在本机 macOS 上用 `npm run release` 完成：

1. 预检：当前在 `main`、工作区干净且等于 `origin/main`，根目录与 `packages/gui` 版本一致，`v<version>` 标签与 Release 都还不存在（标签已在 HEAD 但 Release 缺失时续发），并用只读 `notarytool history` 确认公证凭证。
2. 在临时 worktree 里对 HEAD 跑 `npm ci`、`check:workspace` 和 `build:offline`，本地改动和旧构建产物不会进入 DMG。
3. 下载并按 SHASUMS256 校验官方 Node，缓存在 `~/Library/Caches/amazme-release`。
4. 签名打包、公证、staple 并复核；`--acceptance` 再构建、公证较低版本基线并做隔离安装验收。
5. 生成 `latest.json` 和发布说明，产物留在 `dist-release/<tag>/`。`--dry-run` 到此为止。
6. 打附注标签 `v<version>` 并推送，`gh release create --verify-tag` 上传 DMG、`.sha256` 和 `latest.json`。带 `-` 的预发布版本标为 prerelease，不成为 latest。

本机配置写在 `~/.config/amazme/release.env`（或用 `AMAZME_RELEASE_ENV` 指定），只放 ID 和路径，不放密钥内容：

```bash
APPLE_TEAM_ID=<团队 ID>
ASC_KEY_ID=<Key ID>
ASC_ISSUER_ID=<Issuer ID>
ASC_KEY_PATH=~/path/to/AuthKey_<Key ID>.p8
# SIGNING_KEYCHAIN 默认是登录钥匙串
```

签名分两种，都走同一套由内向外的签名流程：

- 本地预览不带参数，用 ad-hoc 签名，不开 hardened runtime：ad-hoc 没有团队 ID，开了库校验会拒绝加载自带的 Electron 框架。其他机器首次打开会被 Gatekeeper 拦截。
- 发布同时传 `--keychain <钥匙串> --team-id <团队 ID>`，从该钥匙串里选出这个团队唯一的 Developer ID Application 身份，带 hardened runtime 和 `packages/gui/assets/entitlements.mac.plist` 里的权限签应用和 DMG，签完核对 TeamIdentifier。随后 `scripts/notarize-macos.mjs` 提交公证、staple，并用 `codesign --verify --deep --strict` 和 `spctl` 复核后重写 `.sha256`。

签名用钥匙串里已有的 Developer ID 身份，首次签名时 macOS 会询问 codesign 能否使用私钥，选“始终允许”。

公证提交前会离线解析未加密的 PKCS#8 `.p8`，提前发现字面量 `\n`、整段 base64 或损坏的私钥文本；这不验证密钥对应的账户权限。Invalid 结果只在 submission ID 为有效 UUID 时读取日志，并转换为固定的签名、hardened runtime、时间戳或 entitlements 提示。公证提交与日志读取的原始输出、日志路径和任意响应字段不会回显；读取诊断失败也保持公证失败，不会继续 staple。

调用 notarytool 前还会离线核对凭证形状：`ASC_ISSUER_ID` 必须是团队密钥页上方的 Issuer ID UUID，`ASC_KEY_ID` 只能是字母数字，两者都不能有首尾空白，私钥必须是 EC P-256。Issuer 不是 UUID 时 notarytool 以 exit 64 拒绝参数、不发请求；这类参数错误按选项名报告，不带值。格式通过后返回 HTTP 401，说明 Key ID、Issuer ID 与私钥不是同一套，应在 App Store Connect 团队密钥页核对三者，修正 `release.env` 后单独跑 `node --env-file ~/.config/amazme/release.env scripts/notarize-macos.mjs --history-only --key <.p8>` 确认，不构建、不提交归档。个人密钥没有 Issuer ID，不能用于这条流程。公证 Invalid 时，在本机用同一套凭证 `xcrun notarytool log <submission ID> …` 读完整日志，按文件路径定位，不要反复重跑发布。

打包安装依赖时，npm 缓存写在 `Contents/Resources/app/.npm-cache`，签名前必须删掉：公证会解开其中的 tarball，里面未签名的 esbuild 和原生模块会使整包 Invalid。签名只覆盖直接可见的 Mach-O，app 内不应再带任何含二进制的压缩包。

## 独立预览包

`scripts/package-desktop.mjs` 生成可移动的 macOS 预览应用：宿主、运行时闭包和固定版本的官方 Node 一起放进 `AmazMe.app`，启动脚本只引用 `Contents/Resources` 内的路径。用官方 Node 压缩包，不要用 Homebrew 的 Node——后者链接共享的 `libnode`，复制单个二进制会在移动后启动失败；脚本会用 `otool` 拒绝这种二进制。

```bash
# 官方 Node 22.19+ 的 darwin tarball 解压后
node scripts/package-desktop.mjs --node /path/to/node-v22.23.3-darwin-arm64/bin/node --out /tmp/AmazMe --verify
```

`--verify` 会把应用复制到临时目录，PATH 只留系统目录。没有打进 Python 后端时，进程必须报「桌面需要包内的 Python 后端」。打进之后才要求 `desktop smoke:`。产物内的 `Contents/Resources/release-manifest.json` 记录应用版本、Electron、Node 与各内部包版本。内部包不应再包含 `@amazme/coding-agent`。

当前限制：1.0.0 之前用 ad-hoc 预览包在本机验证，不对外发 Release。1.0.0 起，对外分发以 GitHub Release 上公证过的 DMG 为准。产品包统一使用同一个发布版本（以根目录 `package.json` 为准），应用显示、安装包与发布清单一致；`release-manifest.json` 记录实际组合，便于回查。

已通过独立安装产物的真实窗口启动、同宿主状态查询和 Web 同步验证；`AMAZME_GUI_CWD` 指定实际项目，`INIT_CWD` 保留 npm 的原启动位置。开发目录和源码解析器不参与已安装桌面的宿主启动。
