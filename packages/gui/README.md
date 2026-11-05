# @amazme/gui

供个人本机使用的 Electron 窗口，通过本机 Python 的 `connect` 连接共享 Host，再把回环页面装进窗口。业务状态、模型、账号和会话均由 Python 拥有。

## 启动

在仓库根目录执行：

```bash
./start.sh --prepare
./start.sh
```

准备步骤安装本机 Python 与 Node 依赖，并显式安装锁定版本的 Electron 运行时。启动脚本按输入和产物指纹编译所需 workspace，随后直接运行依赖中的 Electron。只编译不启动可用 `npm run dev:desktop -- --build-only`。保留必要的源码编译和类型检查，不生成安装包、冻结后端或缓存应用，不执行签名、公证和 Release，也不提供安装包自动更新。

更新源码后，先在菜单中「停止后台并退出」，再重新运行启动脚本，使共享后台加载当前 Python 源码。普通退出桌面不会重启或停止后台。

`AMAZME_PYTHON_BACKEND` 由启动脚本指向项目虚拟环境中的 `amazme-backend`；`AMAZME_NODE` 使用启动脚本当前的 Node。缺少项目后端时启动失败。窗口开启 `contextIsolation`、`sandbox`、`nodeIntegration: false`。

## 数据与生命周期

业务 profile 默认是 `~/.amazme/agent/python-host`，与 Web 共用。Electron `userData` 默认是 `~/.amazme/desktop`。`AMAZME_GUI_USER_DATA_DIR` 只覆盖壳数据；隔离运行还须设置 `AMAZME_HOME` 或 `AMAZME_PROFILE`。数据目录见[根目录说明](../../README.md#数据目录)。不读取或迁移旧目录。

点击关闭按钮时，默认空闲就退出桌面，有任务时按设置选择隐藏窗口或退出桌面。两种行为都保留共享 Host 和任务，`Cmd/Ctrl+Q` 也只退出桌面。菜单和托盘的「停止后台并退出」会提示所有客户端都将断开，再正常停止 Host 及其服务。失败时保留桌面供重试。

窗口、菜单与快捷键由同一生命周期状态机协调。Host 独占锁和 Python 连接入口协调所有启动者，普通退出不以“谁启动进程”决定后台寿命。界面语言读取共享 Host 的产品设置；Host 不可用时使用系统语言。

## 桌面界面

界面只有 Web 一份实现。macOS 使用 `titleBarStyle: hiddenInset`，红绿灯位于页面自绘的 48px 标题栏中，固定 `trafficLightPosition {x:16,y:18}`，页面给标题栏留出 78px；这些尺寸是一对契约。窗口 resize 或切换主题时，渲染层把页面 canvas 色交给主进程同步原生底色。Windows/Linux 保留系统标题栏。

窗口图标和 macOS Dock 图标使用 Web 包的 `dist/page/app-icon.png`，网页使用同源 SVG favicon 和 PNG 备用。通过依赖中的 Electron 启动，系统应用名称由其开发运行环境决定，不创建另一份原生应用来修改名称。

项目文件夹使用原生目录选择器。preload 只暴露目录选择、桌面菜单转发、窗口底色与平台标识；主进程核对当前窗口、主页和 Host 地址。项目保存、授权和执行目录与 Web 共用后端。

## 验证

开发采用 `confident-development-conventions`。构建、类型检查后，按改动选择受影响的真实桌面路径做有限验收。源码与产物指纹须与构建记录一致；`npm run dev:desktop -- --check-build` 可只读核对。使用独立 profile，完成后清理临时资产。产品自检通过 `AMAZME_GUI_SMOKE=1` 运行，必须同时指定独立产品根或 profile。
