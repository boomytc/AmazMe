# 2026-10-19 本机联调记录

环境：macOS、Retina 2x、固定 `cua-driver 0.34.1`、线上 TypeSafe `jev-1.14.0`。仅对临时 Cocoa 测试窗口操作，发送到 Jev 的图片和 AX 内容均来自该窗口。凭据由本机 zsh 环境提供，没有写入仓库或测试报告。

通过 LaunchServices 启动实际安装的 `AmazMe Computer Use.app` 后，只读诊断确认 `host_bundle_id=com.amazme.computer-use`，辅助功能与屏幕录制均为 `true`。观察得到 1480×984 PNG、AX 控件和原子 `capture_id/snapshot_id`。直接执行 bundle 内入口曾继承终端权限，已修正启动方式。

策略保持默认阈值：存在性 `0.8`、Box/Choice 置信度 `0.7`、总超时 `30s`、禁止前台升级、风险许可为空。未降低阈值或自动重发动作。

| 路径 | 实际结果 |
| --- | --- |
| AX Choice → 后台点击 → 独立 bool 核验 | `Increment Native` 计数由 0 变为 1，核验概率 0.99，返回 `verified`。 |
| AX Choice → 后台赋值 → 独立 bool 核验 | 输入框内容变为 `AmazMe Jev verified`，核验概率 0.99，返回 `verified`。另一次运行因候选判断不足返回 `review`，未写入。 |
| AX abstain → 粗图 Box → 裁剪 Box → 像素点击 → 独立核验 | 定位存在性 0.99/0.98、Box 置信度 0.87/0.97；驱动以 `synthetic_events` 后台派发，Canvas 计数仍为 0。核验概率 0.02，返回 `review`；未自动转前台。 |
| 瓦片 Choice → 块内 bool + Box | 正确选择右上瓦片，Choice 置信度 1；块内 Box 置信度 0.60，低于阈值，返回 `review`，未点击。 |

上述操作期间前台应用 PID 保持不变，测试窗口始终处于后台；结束后关闭临时窗口并释放 Driver 会话。模型输出有波动，这些结果只证明本次链路与门控行为，不能推断其他应用的成功率。

驱动将 Canvas 的后台 CGEvent 投递标为 `effect: unverifiable`。后续已通过目标窗口的真实事件记录定位该次失败，见下节；该标记本身不能判断是否点击成功。

联调还发现并修正：固定版本不接受 `tree_format`；风险上下文缺少动作名称与 AX 标签；`send` 需要明确指对外通信，避免混淆为本地输入事件投递；动作返回的模型调用记录遗漏风险分类请求。滚动与拖动的截图像素协议已与固定版本源码核对，并由自动化回归覆盖，尚未执行真实桌面的滚动或拖动。

原始截图、分类概率与派发记录保存在执行机器的 `/tmp/amazme-computer-use-live-20261019/`，属于临时诊断产物，不作为运行时依赖。

## Canvas 根因与补丁验证

这里的 Canvas 是没有 AX 子元素的 Cocoa 自绘 NSView，已实现 `acceptsFirstMouse:YES`。给临时窗口增加只读事件日志后，确认问题在固定版 cua-driver 的 macOS 鼠标投递层：`click_at_xy_with_window_local` 对全部后台左击套用 Chromium recipe，忽略已经算好的窗口局部坐标，把屏幕点写入 `CGEventSetWindowLocation`。AppKit 按窗口坐标解释它，导致落点越界。插件提交的截图像素、capture 绑定及 Retina 换算均正确。

相同窗口几何与相同截图落点的对照：

| 项目 | 原版 0.34.1 | 补丁版 0.34.1-amazme.1 |
| --- | --- | --- |
| 插件发出的截图像素 | `(1073,504)` | `(1073,504)` |
| 换算后的屏幕点 | `(736.5,709)` | `(736.5,709)` |
| 目标实际收到的 NSEvent 局部点 | `(736.5,-217)`，hitTest=nil | `(536.5,240)`，hitTest=Canvas |
| 业务处理与计数 | 无 mouseDown，计数仍为 0 | 恰好一次 mouseDown，计数 0 → 1 |
| 独立 Jev bool | 0.02，`review` | 0.99，`verified` |

补丁基于上游提交 `0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc`，AppKit 使用已有的窗口局部坐标和单次 public PID 投递；Chromium/Electron 继续使用原有 recipe，包含自定义品牌 Electron 的现有框架识别。没有改动插件策略、风险阈值、前台许可或重试行为。源码补丁及独立安装脚本随插件提供，原版组件与上游 cua 工作区均保留。

新签名最初没有继承 TCC 权限；用户为正式补丁目录授权后，只读检查的两项权限均为 true。已用正式 release 安装组件做两次独立线上 Jev 测试，每次新建计数为 0 的临时窗口，均只派发一次后台点击，计数变为 1、独立核验概率 0.99。首次运行期间前台从原应用切到系统 UserNotificationCenter，因此单独复测：第二次前台 PID 全程为 68754，激活通知日志没有变化，测试窗口始终不是 key window；鼠标坐标前后均为 `(820.109375,-640.3046875)`。两次都没有将目标应用设为前台。

第二次的 AX Choice 为 abstain，粗图/精图存在性为 0.99/0.98、Box 置信度为 0.83/0.97；风险判断仍执行且全部低于原阈值。Driver 仍返回 `effect: unverifiable`，最终成功依据来自目标事件日志、业务计数和动作后的独立观察，不把派发成功当作效果证明。

补丁的鼠标路由单元测试 5 项通过；AmazMe 包构建、插件类型检查、安装校验测试 3 项及 workspace 检查通过。包测试在 `TERM=xterm-256color` 下为 2401 通过、24 跳过；默认 `TERM=dumb` 会使两个原有主题测试失败，未修改这些无关实现。Chromium/Electron 的投递算法保持原样并有路由回归覆盖，本轮没有执行其真实浏览器 Canvas；结果也不涵盖滚动、拖动或其他应用。

对照截图、完整 Jev 概率、派发、事件日志保存在 `/tmp/amazme-canvas-rootcause-20261019/`：`baseline/` 为原版、`patched-first/` 为首次补丁验证、根目录为第二次补丁验证。测试结束已关闭窗口并释放自己的 Driver 会话。补丁 release 驱动的本机签名后 SHA-256 为 `d433b05e852cb66772d3290e4c91fb8cc954775f9691abfe6c6109fab2d80666`，其他机器重新构建或签名后哈希可能不同。
