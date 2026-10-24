# Computer-use native recipe

这里仅保留 CUA App 的固定源码配方、签名/完整性核对、权限 App 生成和已拥有安装目录的清理 helper。
产品的驱动、TCC 状态、动作账本、Jev 分类与定位/验证均由 Python 实现，见 [现行契约](../../../../docs/python-backend-plan.md)。

不再注册 TS session facet。`scripts/prepare-computer-use.mjs` 是本机按固定版本准备驱动的入口，不会因运行助手而自动重建或提升版本。安装与清理只处理原清单可证明拥有的目录；不删除未知版本、其他会话资源或用户数据。

旧实机验证数字见 Git 历史 `400f9805`，不代表当前 Python 实现已取得系统授权或调用真实分类账号。本轮按用户要求不追加账号或设备验收。
