# Changelog

## 0.1.0

- 建立独立 Python Host、会话 worker 与执行监督器，不依赖旧 TS 业务内核。
- 提供 Web 客户端、DeepSeek Flash 流式调用及受管 VM 文件/shell 工具。
- 使用 SQLite 事务请求去重、事件恢复、取消与未知副作用记录。
- 通过容器执行域和持久清理回执限制 worker 替换，拒绝旧 Host 代际和不同构建控制。
- 提供包内 Python、Lima 与离线镜像的本机独立 onedir 及实际运行验收工具。
- 收敛重复取消、并发 worker 分配、断连任务容量回收和 VM 删除互斥；补齐丢回执、断网、会话切换与快照恢复验证。
- 只读快照在 worker 退役后返回会话重启预算耗尽，关闭监督器时先放开控制锁再等 worker 退出。
