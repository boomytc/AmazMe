# Computer Use

可选原生插件。执行与截图来自外部 `cua-driver`，AX 候选选择和图片定位使用宿主的 TypeSafe `jev-1.14.0` 分类器。不依赖 OmniParser，不把驱动二进制打进默认 npm 包。

**当前默认运行时为 `0.38.0-amazme.2`，已于 2026-10-22 通过本机 macOS 受控桌面验收。**

本轮验证原生 AX 点击、赋值、输入，自绘 Canvas 点击、滚动与拖动，以及 Chrome 和自定义品牌 Electron 的 Canvas 精确点击、滚动；12 项动作及前台/鼠标保持检查通过。画布定位使用确定性测试图形，后置状态读取目标应用自身的记录；本轮未调用线上 Jev。旧版线上 Jev 联调属于历史证据。

Windows/Linux 真机、完整动作矩阵、瓦片定位成功路径及 TUI/Web/GUI 各入口的完整流程仍未全部验收，详见[集成验收记录](./LIVE-VALIDATION.md)。

```bash
amazme -e /path/to/AmazMe/packages/coding-agent/plugins/computer-use
```

源码运行也可用 `node packages/coding-agent/dist/bundle/cli.js -e packages/coding-agent/plugins/computer-use`。加载后只注册 4 个高层工具，模型不能直接调用底层驱动工具。原生插件在本机 session 进程执行；远程宿主控制的是宿主桌面。

## 开启与策略

```text
/computer-use status
/computer-use permissions
/computer-use setup
/computer-use on
/computer-use {"minPresence":0.9,"allowForeground":false}
/computer-use {"allowRiskCategories":["send"]}
/computer-use off
```

默认关闭桌面访问；Jev 默认开启，供应商 `typesafe`，模型 `jev-1.14.0`，存在性阈值 `0.8`，Box 与 Choice 置信度阈值均为 `0.7`，操作总超时 `30000ms`。所有字段可用 JSON 修改，拒绝未知字段、非法概率和非法风险类别。策略按对话持久化，沿用 Durable 的分叉与回溯语义；原生快照只在内存中保存，重开和 `/reload` 后必须重新观察。

只有用户命令可以修改策略，工具参数不提供开关、模型或风险许可。命令与工具共用串行锁，配置写入沿用宿主的可写对话及归档检查。修改策略时释放旧 Driver 会话；`off` 同时结束其子进程。

`permissions` 是用户显式请求的诊断，关闭状态也可运行；模型工具在关闭状态一律拒绝，不启动驱动或访问分类器。AmazMe macOS 宿主通过独立进程只读检查权限，不启动桌面服务或申请授权；其他来源使用 Driver 的 `check_permissions`，首次启动可能出现该运行时自己的权限引导。诊断不代替系统授权。

开启功能时检查权限；macOS 上读取窗口、定位或执行动作前也先只读检查。缺少权限时停止本次操作，返回 `permission_required` 与操作说明，清理旧快照，不调用 Jev 或继续派发动作。对已识别的 AmazMe macOS 组件会弹出原生引导，显示缺少的权限、实际 `.app` 完整路径及新版系统设置名称；远程连接需要在运行 AmazMe 的宿主机完成授权。

原生面板用两个列表项分别展示辅助功能、屏幕录制，绿色勾选和“已授权”、橙色提示和“待授权”同时标识状态；暂时无法读取时显示“待检查”。每项提供“前往设置”或“查看设置”，直接跳转到对应系统设置页。面板保留，返回时自动只读刷新，也可点击“重新检查”；全部就绪后显示“完成”。若列表没有该应用，使用“＋”添加面板显示的实际路径（长路径可悬停查看完整内容）。系统可能要求退出并重新打开应用，按提示操作后重新检查。授权由用户在系统设置中完成。

同一应用不会因模型连续失败反复弹窗；`setup` 可显式重新打开引导，关闭状态也可使用且不自动开启桌面控制。重新检查只做权限诊断，权限就绪后需重新观察并发起新操作，不自动重发原动作。`off`、重载和会话关闭会取消并等待引导进程退出。非 macOS、其他来源的运行时或弹窗不可用时保留文字指导；`permissions` 命令始终不弹窗。

权限面板是独立的 AppKit 应用，仅展示状态、跳转系统设置和请求只读刷新，不拥有桌面控制权限。macOS 可选安装脚本会编译并缓存面板（需要 Xcode Command Line Tools）；已有运行时首次需要面板时也会尝试准备，失败则保留命令和工具中的完整文字指导。缓存位于 `~/Library/Caches/AmazMe/ComputerUse/permissions/`，复用前校验源码、可执行文件摘要与应用签名；更新面板不改变实际 Computer-use 宿主的权限身份。

风险类别为 `destructive`、`send`、`purchase`、`close_unsaved`。AX 标签中的中英文风险短语默认排除；视觉和键盘动作还需 Jev 判断风险，未确定安全时返回 `review`。标签过滤与模型判断都不能保证识别所有风险，应按具体任务配置许可。

## 准备运行时

优先使用显式的可执行绝对路径：`AMAZME_CUA_DRIVER_PATH`，其次 `CUA_DRIVER_PATH`。未配置时探测：

1. AmazMe 托管安装目录：macOS 为 `~/Library/Application Support/AmazMe/ComputerUse/`，Linux/Windows 为 `~/.local/share/AmazMe/ComputerUse/`。按源码清单明确选择版本，不扫描目录排序：macOS 只选择 `0.38.0-amazme.2`，不自动回退历史版本；其他平台选择固定原版 `0.38.0`。
2. `~/.local/bin/cua-driver`（Windows 为 `.exe`），以及 `PATH`。

托管目录在安装复用和运行发现时使用同一个校验器，检查平台、架构、来源、文件哈希及 macOS 签名。已存在的优先版本缺少 manifest 或校验失败时直接报错，不悄悄退回另一份驱动。未列入清单的版本、开发目录和 PilotDeck 安装不会自动选中；使用外部运行时需显式设置路径。
已有 `.app` 使用它自身的身份；AmazMe/PilotDeck 的宿主可通过 `.app/Contents/Info.plist` 中的入口识别，经 LaunchServices 在后台启动，以私有 socket 和权限为 `0600` 的 stdin FIFO 管理 embedded Driver，再用 stdio MCP 代理连接。调用方关闭或退出后，FIFO 的 EOF 通知宿主结束；卡住时只终止匹配当前私有 socket 的宿主和服务进程，并等待退出。直接执行 bundle 内入口会继承终端的权限归属，因此服务和只读权限诊断都通过 LaunchServices 启动。普通独立驱动执行 `cua-driver mcp`。进程只接收必要的系统/桌面会话环境，不转发模型密钥，并关闭 Driver 遥测。

仓库准备入口在 macOS 安装当前补丁修订版；已有同版组件通过校验后离线复用，首次构建需要 `--source /path/to/cua`。其他平台固定下载原版 `0.38.0`，验证 SHA-256 后安装；均不参与常规包构建：

```bash
node scripts/prepare-computer-use.mjs
# 首次从源码构建 macOS 补丁：
node scripts/prepare-computer-use.mjs --source /path/to/cua
# 安装后的 npm 包也包含独立脚本：
node /path/to/coding-agent/plugins/computer-use/scripts/prepare-patched-computer-use.mjs --source /path/to/cua
# 需要原版时显式运行：
node /path/to/coding-agent/plugins/computer-use/scripts/prepare-computer-use.mjs
```

脚本输出安装目录和二进制绝对路径。macOS 安装到上述共享组件的版本子目录，编译通用宿主 `AmazMe Computer Use.app`，需要 Xcode Command Line Tools。默认使用本地 ad-hoc 签名；可通过 `AMAZME_CUA_SIGNING_IDENTITY` 指定签名身份。生产交付需使用稳定的签名身份。TUI、Web 和 GUI 使用同一个安装组件时共享该宿主的 TCC 身份，系统仍决定权限归属及是否需要重新授权。请在系统设置中为实际宿主授予辅助功能、屏幕录制权限；新版 macOS 可能分别显示为“设备控制和数据访问”“录屏与系统录音”。Linux/Windows 需要已登录且可访问的桌面会话。

Linux/Windows 脚本安装到 `~/.local/share/AmazMe/ComputerUse/0.38.0/`；使用输出路径设置 `AMAZME_CUA_DRIVER_PATH`。已有组件通过 manifest 与二进制哈希核验后复用，内容不同则拒绝覆盖。未安装驱动不影响包构建或插件注册。

macOS 补丁固定导出上游提交 `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19` 的 Git 对象，应用 `scripts/patches/cua-driver-0.38.0-background.patch`，运行鼠标路由回归，再以固定工具链和 Cargo.lock 构建 release 驱动；不使用或修改 cua 的工作区。需要 Rust/rustup、Git 与 Xcode Command Line Tools。过程宏保留调试信息以避开 [Rust 的 macOS LINKEDIT 问题](https://github.com/rust-lang/rust/issues/157750)，最终驱动使用 release 优化。

补丁让后台点击、拖动和滚动保留窗口局部坐标，并仅投递一次；Chromium/Electron 左击保留后台激活步骤。像素点击不再转成会丢失落点的 AXPress；显式 AX token 操作不变，不启用前台回退。

当前组件安装到 `~/Library/Application Support/AmazMe/ComputerUse/0.38.0-amazme.2/`。完整修订号写入目录、manifest、Info.plist 的 `AmazMeRuntimeVersion` 和应用说明；Apple 短版本为 `0.38.0`，构建号为 `4`，与 AmazMe 应用版本独立。安装记录保存源码提交、补丁及驱动、宿主、Info.plist 的摘要；不同内容拒绝覆盖同一版本。新签名可能需要重新授权。

本机仅保留此版本；旧运行时、旧构建产物、旧补丁配方和自动回退已移除。缺少当前版时不会选中旧托管目录。未来升级可以先添加独立候选配方并用 `--version` 验证，全部通过后再修改 `DEFAULT_PATCH_VERSION`；安装本身不会晋升默认。

```bash
node scripts/verify-computer-use-macos.mjs
# 单独复测 native、chromium 或 electron：
node scripts/verify-computer-use-macos.mjs --surface native
```

脚本需要当前宿主的两项权限、Chrome 和仓库 Electron 依赖，只打开临时 Cocoa 窗口、独立浏览器配置和改名后的 Electron 测试页。运行时暂停人工鼠标/键盘操作，以免干扰检查。报告和截图写入 `dist-release/computer-use/<运行时版本>/validation/`；退出时等待自己的全部进程结束，清理无占用产物，其他应用仍占用的文件会被保留并记录。

### 构建工作目录与清理

仓库入口把 Rust 源码导出和 Cargo target 放到 `dist-release/computer-use/<运行时版本>/.build-<随机值>/`，运行时版本独立于 AmazMe 应用版本；每次构建独占目录并登记所属进程，完成或失败后回收无占用的工作目录。版本目录带有本工具的归属标记，桌面验收也登记活动进程。安装后的独立脚本使用 `~/Library/Caches/AmazMe/ComputerUse/build/`。正式运行时仍在 Application Support，权限面板仍在 Caches；应用发布只清理自己的 `dist-release/v*` 目录，保留 `computer-use/` 命名空间。

macOS 默认版本构建、校验并原子安装成功后，准备命令自动清理旧运行时、旧版本产物和旧缓存；已有默认版通过校验后离线复用时也重试清理。构建失败、默认版缺失或损坏时不清理历史版本；准备候选版或自定义安装目录不会触发自动清理。只删除比默认版更旧的版本，未来候选版保留到验收晋升后再处理。

```bash
node scripts/cleanup-computer-use.mjs          # 预览
node scripts/cleanup-computer-use.mjs --apply  # 执行
# 安装后的插件也可清理自己的缓存：
node /path/to/coding-agent/plugins/computer-use/scripts/cleanup-computer-use.mjs --apply
```

仓库清理命令与自动清理共用同一实现：验证当前默认运行时后，根据旧运行时的 manifest、哈希、签名和 AmazMe 应用标识确认归属；旧版本产物按归属标记识别，不依赖旧配方仍在源码清单中。保留当前版、当前权限面板、活动构建或验收，以及任何仍有文件或可执行映射占用的目录；符号链接及无法识别的内容不删除。结果逐项报告 `removed`、`busy` 或 `unrecognized` 等状态，占用释放后再次运行即可完成清理。无法可靠检查占用时报错，已安装的新版本保持可用。不会扫描清理 `/tmp` 或其他产品目录。安装临时目录仍在目标目录旁，以便同卷原子安装。

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

自动化测试使用真实 stdio MCP 伪驱动和确定性分类器，覆盖插件重载、关闭、策略隔离、风险过滤、快照绑定和真实图片裁剪；macOS 宿主生命周期测试会用 Xcode Command Line Tools 编译临时 Cocoa 应用，验证 LaunchServices、FIFO 和卡住时的清理。测试也覆盖驱动不声明 `tree_format` 时省略该参数的协议路径。它们不能证明实际桌面权限、后台投递效果或线上 Jev 识别质量。手工验证时先 `status/permissions/on`，选择计算器等测试窗口，观察后执行可逆操作，再检查独立观察与后置条件。

已执行的本机权限、线上 Jev 和后台动作结果见[联调记录](./LIVE-VALIDATION.md)，其中包含原版 Canvas 未生效的根因和低置信度拒绝的边界。
