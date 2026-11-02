# Changelog

## [Unreleased]

### Removed

- 交互终端模式及只服务它的主题、快捷键、剪贴板和语法高亮实现；公开入口移除主题、编辑器、`runPythonSessionTui`、`copyToClipboard` 与 `convertToPng`，图片转换改用 `convertImageBytesToPng`。无参数运行输出帮助，问题按一次性命令执行。

## [0.1.0] - 2026-10-24

### Changed

- CLI/TUI 客户端连接 Python Host，SDK 使用 Python API。版本与当前产品线对齐；旧包历史见 Git。
