# P0/P1 实施记录

- [x] Ground：以定稿 Python 方案和选型运行证据为约束，独立产品线 0.1.0。
- [x] Sketch：比较两种局部 IPC/资源所有权接口，选择 HTTP over UDS，固定模块契约。
- [x] Agree：用户已授权实施；首客户端 Web，真实模型复用现有 DeepSeek 配置仅作隔离验证。
- [x] Implement：工程与 schema → 固定 VM 资源 → 监督器 → worker/持久化 → Host/Web → 独立包。
- [x] Verify：真实模型工具闭环、取消/强杀/恢复、清理阻塞准入、构建/代际拒绝、独立安装实跑与证据。
- [x] Scrap：资源适配和供应商边界问题在唯一入口修正，无兼容桥接或未受管 shell 回退。

设计比选只处理实施接口，不重新讨论已定的 Python/SQLite/VM 架构。

最终构建、断言和未覆盖的后续矩阵见 `docs/python-backend-p1-evidence.md`。
