# Computer Use

可选原生插件。执行与截图来自外部 `cua-driver`，AX 候选选择和图片定位使用宿主的 TypeSafe `jev-1.14.0` 分类器。不依赖 OmniParser，不把驱动二进制打进默认 npm 包。

```bash
amazme -e /path/to/AmazMe/packages/coding-agent/plugins/computer-use
```

源码运行也可用 `node packages/coding-agent/dist/bundle/cli.js -e packages/coding-agent/plugins/computer-use`。加载后只注册 4 个高层工具，模型不能直接调用底层驱动工具。原生插件在本机 session 进程执行；远程宿主控制的是宿主桌面。

## 开启与策略

```text
/computer-use status
/computer-use permissions
/computer-use on
/computer-use {"minPresence":0.9,"allowForeground":false}
/computer-use {"allowRiskCategories":["send"]}
/computer-use off
```

默认关闭桌面访问；Jev 默认开启，供应商 `typesafe`，模型 `jev-1.14.0`，存在性阈值 `0.8`，Box 与 Choice 置信度阈值均为 `0.7`，操作总超时 `30000ms`。所有字段可用 JSON 修改，拒绝未知字段、非法概率和非法风险类别。策略按对话持久化，沿用 Durable 的分叉与回溯语义；原生快照只在内存中保存，重开和 `/reload` 后必须重新观察。

只有用户命令可以修改策略，工具参数不提供开关、模型或风险许可。命令与工具共用串行锁，配置写入沿用宿主的可写对话及归档检查。修改策略时释放旧 Driver 会话；`off` 同时结束其子进程。

`permissions` 是用户显式请求的诊断，关闭状态也可运行；模型工具在关闭状态一律拒绝，不启动驱动或访问分类器。AmazMe macOS 宿主通过独立进程只读检查权限，不启动桌面服务或申请授权；其他来源使用 Driver 的 `check_permissions`，首次启动可能出现该运行时自己的权限引导。诊断不代替系统授权。

风险类别为 `destructive`、`send`、`purchase`、`close_unsaved`。AX 标签中的中英文风险短语默认排除；视觉和键盘动作还需 Jev 判断风险，未确定安全时返回 `review`。标签过滤与模型判断都不能保证识别所有风险，应按具体任务配置许可。

## 准备运行时

优先使用显式的可执行绝对路径：`AMAZME_CUA_DRIVER_PATH`，其次 `CUA_DRIVER_PATH`。未配置时探测：

1. macOS 的 `~/Library/Application Support/AmazMe/ComputerUse/` 共享组件及其版本子目录。
2. 同结构的 PilotDeck 组件、`/Applications/CuaDriver.app/Contents/MacOS/cua-driver` 和 PilotDeck 应用内组件。
3. `~/.local/bin/cua-driver`（Windows 为 `.exe`），以及 `PATH`。

已有 `.app` 使用它自身的身份；AmazMe/PilotDeck 的宿主可通过 `.app/Contents/Info.plist` 中的入口识别，经 LaunchServices 在后台启动，以私有 socket 和权限为 `0600` 的 stdin FIFO 管理 embedded Driver，再用 stdio MCP 代理连接。调用方关闭或退出后，FIFO 的 EOF 通知宿主结束；卡住时只终止匹配当前私有 socket 的宿主和服务进程，并等待退出。直接执行 bundle 内入口会继承终端的权限归属，因此服务和只读权限诊断都通过 LaunchServices 启动。普通独立驱动执行 `cua-driver mcp`。进程只接收必要的系统/桌面会话环境，不转发模型密钥，并关闭 Driver 遥测。

可选的一键准备脚本固定下载 `0.34.1`，验证对应平台的 SHA-256 后安装，不参与常规构建：

```bash
node scripts/prepare-computer-use.mjs
# 安装后的 npm 包也包含插件内脚本：
node /path/to/coding-agent/plugins/computer-use/scripts/prepare-computer-use.mjs
```

脚本输出安装目录和二进制绝对路径。macOS 安装到上述共享组件的版本子目录，编译通用宿主 `AmazMe Computer Use.app`，需要 Xcode Command Line Tools。默认使用本地 ad-hoc 签名；可通过 `AMAZME_CUA_SIGNING_IDENTITY` 指定签名身份。生产交付需使用稳定的签名身份。TUI、Web 和 GUI 使用同一个安装组件时共享该宿主的 TCC 身份，系统仍决定权限归属及是否需要重新授权。请在系统设置中为实际宿主授予辅助功能、屏幕录制权限；新版 macOS 可能分别显示为“设备控制和数据访问”“录屏与系统录音”。Linux/Windows 需要已登录且可访问的桌面会话。

Linux/Windows 脚本安装到 `~/.local/share/AmazMe/ComputerUse/0.34.1/`；使用输出路径设置 `AMAZME_CUA_DRIVER_PATH`。已有组件通过 manifest 与二进制哈希核验后复用，内容不同则拒绝覆盖。未安装驱动不影响包构建或插件注册。

macOS 原版 `0.34.1` 把 AppKit 自绘控件也送入 Chromium 的屏幕坐标点击路径，会导致窗口收到错误的局部坐标。需要此修复时，可从含有固定提交的本地 cua 仓库构建补丁版：

```bash
node packages/coding-agent/plugins/computer-use/scripts/prepare-patched-computer-use.mjs --source /path/to/cua
```

脚本只导出上游提交 `0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc` 的 Git 对象，应用随插件提供的补丁，以固定工具链和 Cargo.lock 构建 release 驱动；不使用或修改该仓库的工作区。需要 Rust/rustup、Git 与 Xcode Command Line Tools，首次构建需要下载工具链和依赖。过程宏保留调试信息以避开 [Rust 的 macOS LINKEDIT 问题](https://github.com/rust-lang/rust/issues/157750)，最终驱动仍使用 release 优化。

补丁版安装到 `~/Library/Application Support/AmazMe/ComputerUse/0.34.1-amazme.1/`，保留原版；自动发现会优先选它，显式路径配置仍优先。安装记录保存源码提交、补丁及驱动、宿主、Info.plist 的 SHA-256，复用时还核验应用签名；不同内容拒绝覆盖。重复运行无需源码和联网。新签名可能需要为该目录下的应用重新授予屏幕录制和辅助功能权限。AppKit 使用窗口局部坐标的一次 PID 定向投递，Chromium/Electron 保留原路径，不启用前台回退。

TypeSafe 使用宿主现有的模型目录与认证流程，支持 `TYPESAFE_API_KEY` 或已保存的 TypeSafe 凭据。截图、AX 文本和动作上下文会随对应工具请求发送到配置的分类器供应商。`{"jevEnabled":false}` 可关闭分类请求；此时仅允许已过滤的 AX 单步/批量点击与文本动作，视觉定位和键盘风险判断不可用。

## 工具

所有工具均为 `executionMode: "sequential"`、`replay: "unsafe"`，同一控制器还持有进程内串行锁。中断后的动作与计费请求不会自动重发。

| 工具 | 输入与结果 |
| --- | --- |
| `cu_observe` | `action: apps/windows/permissions/window/desktop`；`windows` 可指定 `pid`，`window` 要求 `target: {pid, window_id}`。窗口/桌面观察返回截图、精简树、候选表和原子 `capture_id`；窗口还返回 `snapshot_id`。 |
| `cu_locate` | `target`（桌面省略）、当前 `capture_id`、`description` 和 `mode: look_closer/tiled`。返回 `located/review`、原始截图像素框、中心、存在性、置信度、裁剪预览及模型调用记录。默认先裁剪定位，不能确定时尝试瓦片；阈值不降低。 |
| `cu_act` | `target`、当前 `capture_id`、可选 `snapshot_id`、`intent` 和 `actions`（1–16 项）。支持点击、双击、右击、赋值、输入、按键、组合键、滚动和拖动。每项用 `action` 区分，参考下例。成功派发返回 `acted`，需再次观察确认实际效果。 |
| `cu_ground_and_act` | `target`、`goal`、明确的 `verification`；可选 `action: click/set_value/type_text` 及 `text`。执行至多一个动作，然后独立观察并用 bool 验证后置条件，返回 `verified/review/already_satisfied`。文本动作必须匹配 AX 字段。 |

```json
{"action":"window","target":{"pid":123,"window_id":456}}
```

接着用实际返回的引用执行动作：

```json
{
  "target":{"pid":123,"window_id":456},
  "capture_id":"实际返回的 capture_id",
  "snapshot_id":"实际返回的 snapshot_id",
  "intent":"点击 Increment",
  "actions":[{"action":"click","element_token":"实际返回的 element_token"}]
}
```

`click/double_click/right_click` 优先使用 `element_token`；否则用截图内的 `x/y`，Driver 在同一点击请求中校验 `capture_id`。`set_value` 用 `value`，`type_text` 用 `text`，均要求当前 AX token；`press_key` 用 `key`，`hotkey` 用 `keys`；`scroll` 用 `element_token` 或 `x/y`，并提供 `direction/amount`；`drag` 用 `x/y/to_x/to_y`。所有坐标保持截图像素，由 Driver 换算屏幕位置和 Retina 比例。滚动与拖动在本地检查 capture 归属；Driver 的原子 capture 检查适用于点击。

动作默认 `delivery_mode: background`，前台必须由用户策略放行并在动作中显式选择。桌面动作只支持前台，当前默认策略会拒绝。`set_value` 使用 Driver 的后台 AX 语义，不传它不接受的 delivery 字段；其他动作缺少请求模式支持时直接拒绝。后台拒绝不会自动升级前台或重试。

批量 AX 动作在每步后重新观察，按角色、标签与祖先路径的稳定 ID 重绑 token；目标消失时停止。坐标动作必须单独调用。快照最长在本地保留 55 秒，跨窗口、过期和动作尝试后的旧引用会被拒绝。Driver 还会进行自身的新鲜度与截图归属校验。

Jev 请求前先执行 EXIF 方向矫正；每张发出的图片短边至少 280px、长边至多 1568px、总像素至少 78400。粗图长边优先 640px，裁剪精图至多 1568px；极端长宽比无法满足约束时返回 review。小区域从原图借像素补到 280px，原图本身不足时等比放大。每次 Box 请求同批附带存在性 bool，Choice 包含 abstain/reobserve，瓦片还含 none；非法闭集 ID、概率分布、坐标或低置信度均不执行动作。

## 验证

```bash
npm run build --workspace @amazme/coding-agent
npx tsc -p packages/coding-agent/plugins/computer-use/tsconfig.json
cd packages/coding-agent
npx vitest run test/computer-use-plugin.test.ts
npm test
```

自动化测试使用真实 stdio MCP 伪驱动和确定性分类器，覆盖插件重载、关闭、策略隔离、风险过滤、快照绑定和真实图片裁剪；macOS 宿主生命周期测试会用 Xcode Command Line Tools 编译临时 Cocoa 应用，验证 LaunchServices、FIFO 和卡住时的清理。固定的 `0.34.1` 不声明 `tree_format`，测试也覆盖省略该参数的协议路径。它们不能证明实际桌面权限、后台投递效果或线上 Jev 识别质量。手工验证时先 `status/permissions/on`，选择计算器等测试窗口，观察后执行可逆操作，再检查独立观察与后置条件。

已执行的本机权限、线上 Jev 和后台动作结果见[联调记录](./LIVE-VALIDATION.md)，其中包含原版 Canvas 未生效的根因和低置信度拒绝的边界。
