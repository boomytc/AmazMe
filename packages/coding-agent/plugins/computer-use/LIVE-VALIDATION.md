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

驱动明确将 Canvas 的后台 CGEvent 投递标为 `effect: unverifiable`，并提示依赖硬件指针位置的应用可能收不到目标事件。本次 Canvas 未生效的具体原因未完全确定，因此不能宣称纯视觉后台点击已验证成功。

联调还发现并修正：固定版本不接受 `tree_format`；风险上下文缺少动作名称与 AX 标签；`send` 需要明确指对外通信，避免混淆为本地输入事件投递；动作返回的模型调用记录遗漏风险分类请求。滚动与拖动的截图像素协议已与固定版本源码核对，并由自动化回归覆盖，尚未执行真实桌面的滚动或拖动。

原始截图、分类概率与派发记录保存在执行机器的 `/tmp/amazme-computer-use-live-20261019/`，属于临时诊断产物，不作为运行时依赖。
