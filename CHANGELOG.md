# Changelog

本文件记录 AmazMe 产品版本的对外变化。各包的 API 细节见 `packages/*/CHANGELOG.md`。

## v0.2.0 - 2026-10-21

### 新增

- TUI 在 Rex 终端中启用 Kitty 图片，并识别 true color 与 OSC 8 超链接。
- codemode worker 达到上限时按到达顺序排队等待，最多 60 秒；可用 `AMAZME_CODEMODE_MAX_WORKERS` 调整上限。
- 扩展可以导入 `@amazme/ai/models`，同时保留旧名称 `@mariozechner/pi-ai/models`。
- `@amazme/chord` 增加 SQLite `exclusive()` 独占操作和复制连接包装，供复制引擎在不受自动 checkpoint 干扰的连接上工作。

### 修复

- 进程未调用 `stop()` 直接退出时，同步恢复鼠标跟踪、焦点报告、Kitty 键盘协议、括号粘贴和备用屏幕。
- 未闭合的行间公式不再吞掉或破坏其后的 Markdown 表格。
- TUI 与 HTML 导出都能在紧邻中文标点时正确渲染 Markdown 粗体和斜体。
- POSIX 下剪贴板助手使用独立进程组，不会随主进程退出被一起终止。
- 读取 `mcp.json` 时去掉 UTF-8 BOM，PowerShell 等工具写入的配置可以正常加载和编辑。
- 移除 ChatGPT 账号不可用的 Codex 模型，识别更多图片载荷拒绝形态，并修正工具定义缓存和 413 请求过大判断。
- Windows 命令发现支持 Microsoft Store 别名和标准 PowerShell 安装目录，并区分 WSL 的 bash 与 Git Bash。

### 其他

- 发版改为在本机运行 `npm run release`，仓库不再使用 GitHub Actions；DMG 仍使用 Developer ID 签名并通过 Apple 公证。

## v0.1.0 - 2026-10-20

- 首个公开版本，提供 macOS arm64 的签名公证 DMG，包含 TUI、Web 与桌面端、会话持久化、扩展与 MCP、模型接入和更新检查。
