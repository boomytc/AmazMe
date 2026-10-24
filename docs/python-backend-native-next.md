# 本机优先阶段交接

2026-10-24，分支 `dev`。模型驱动 MCP 已按会话审批闭环验收。完整终端、其余客户端、产品能力和安装仍未完成，整个 Python 重构尚未完成。
现行设计只有 [本机优先方案](python-backend-plan.md)；旧 P0/P1/P2 的 VM 方案与验收数字仅保留历史意义。

## 已形成的提交单元

| 单元 | 提交 / 定位 | 运行证据 |
| --- | --- | --- |
| B 本机 shell、文件、审批、检查点 | `b6c2d7a26e1dd769960313ab22bd30af47836751` | [证据](python-backend-native-evidence.json)：Chrome、真实 DeepSeek、本机文件副作用及恢复 |
| C1 会话 PTY | `de851ab7e5ec4af47c147ba2455abcca941394d2` | [证据](python-backend-native-terminal-evidence.json)：Chrome、resize、重连、输入去重、真实进程崩溃 |
| C2 本机 MCP 服务与手动调用 | 包含本文件的 `feat(backend): 让本机 MCP 服务保留审批与不确定调用事实` 提交 | [证据](python-backend-native-mcp-evidence.json)：官方 SDK 服务、Chrome、审批丢回执、结构化结果、取消和崩溃 |
| 资源普查 | `b26d1d47c3154ad768173f6026effa9b0618b344` | 隔离 Host 的 serve/supervisor 被标为临时泄漏，关闭后所属进程退出；该次 build_id 未变 |
| C2 模型驱动 MCP | 包含本文件的提交 | [证据](python-backend-native-mcp-model-evidence.json)：DeepSeek 选择本机探针，拒绝无副作用，结果回到模型 |

没有推送、合入 main、打标签或发布。手动 MCP 源码 build_id 为
`10bfc410a56b2b5026aa151310afd5a06eeece762131a38398bf33cd1d7692a3`。
当时全套 456 项通过；Ruff、Pyright、wheel/sdist、工作区检查通过。那次 MCP 运行未调用付费模型。
这 456 项包含当时尚未提交的资源检查测试，不能把它们说成已经进入手动 MCP 提交。
模型驱动 MCP 的源码 build_id 为 `a84da7c3b4b8ea555cc12a4a096a2fd306fe76ae46797e70606e16d1fd1e364b`。
最终源码上后端测试 475 项通过；Ruff、Pyright 和工作区规则通过。真实模型证据只覆盖隔离探针上的选择、拒绝和结果回传。

资源普查命令只报告。用户主目录里的常驻服务保持 observed。打包和运行器只删除自己目录中没有进程引用的超限产物；VM 目录和 `am2-*` 临时目录未确认前不删，也不为此安装或启动虚拟机。
下次再跑已有两份记录的运行器时，会让出该前缀最旧且无人使用的一份：`run-y5ei8l8q`、`terminal-err1kda9`、`mcp-xi0hnry9`、`client-160ayfgl`。台账引用的较新目录仍留下。

## 剩余执行顺序

1. **完整终端与客户端。** Web 当前只有 32 KiB 文本尾部，补完整终端模拟；逐个复核 Electron、TUI、CLI、RPC、SDK。
   验收实际本机 shell/文件/审批/检查点/PTY/MCP，覆盖多窗口、多会话、断线、旧绑定、关闭归属和更新期间停止。
   旧客户端已有实现先追踪源码，缺什么补什么，不另建一套业务运行时。
2. **按真实需求补齐产品功能。** 对照台账逐项复核供应商/账号、OAuth、SSH、多工作区、插件、Codemode、computer-use、
   记忆、工作流、定时任务、网页工具、导入导出及分享。区分已有实现和仅有 faux/协议测试；需要 TCC、真实 SSH 或
   真实供应商的功能取得对应证据。MCP 动态目录刷新、HTTP/OAuth、媒体与更多服务兼容性独立验收，不提前泛化。
3. **本机安装与交付。** 只构建一份当前包；更新实验最多明确 A/B 两份。验证独立安装、含空格路径、受控 PATH、
   离线首次启动、构建混用拒绝、升级冻结/核对。Developer ID、hardened runtime、公证、staple、Gatekeeper 都保留。
   旧签名 VM 包不能充当当前证据。真实睡眠/唤醒、物理空间耗尽、断电未验收；需要用户机器状态配合的实验单独安排。
   所有消费者迁入 Python 并验证后删除剩余 TS 业务依赖，保留客户端呈现和有明确用途的 JS helper。

每一项按完整功能闭环拆成独立原子提交，不把上述剩余工作积成一次巨型提交。

## 不改变的理念

- 本机是唯一执行主路径；不恢复 Lima/Docker/镜像，不维护双后端和无场景适配层。
- Python 业务内核继续复用。锁、代际、账本和恢复机制各自解决已知并发/崩溃问题，按用途保留或简化。
- shell 通常拥有当前用户权限。路径检查和审批不是 OS 沙箱；认证、授权、凭据隔离、高风险确认和签名要求保留。
- 取消已接收、调用结果、受管进程退出是不同事实。只核对直接/已观察后代，不承诺任意脱离后代都停止；unknown 不自动重放。
- 终端、开发服务器和 MCP 属于会话。页面断开或 worker 回收不等于用户要求关闭；重启不能擅自重启第三方命令。
- 纠错先落在结构和状态不变量，再用自动化测试守住。资源预算放在构建/运行入口，阶段收尾运行同一普查；文字只留归属判断。

## 验证与原子提交

先读实际 Git 状态和本机方案，确认无其他测试运行。不要同时启动多份整套运行验证。

```bash
backend/.venv/bin/python backend/tools/resource_census.py
uv build --project backend
backend/.venv/bin/ruff check backend
backend/.venv/bin/pyright --project backend/pyproject.toml
backend/.venv/bin/pytest backend/tests -q
npm run check:workspace
```

按改动选择 `verify_native.py`、`verify_client.py`、`verify_terminal.py`、`verify_mcp.py`、`verify_mcp_model.py`；
真实模型才运行 `verify_web.py --provider-config /private/provider.json` 或 `verify_mcp_model.py`。
模型 MCP 验证只读取 zsh 的 `DEEPSEEK_API_KEY`，写入权限 0600 的临时配置，结束后删除该文件并清空隔离 profile 的密钥。
不得输出密钥、复制全部环境到工具或把凭据放进仓库。MCP 探针依赖 `uv sync --project backend --frozen` 的开发依赖。
运行器有数量上限，已有两份证据时先核对和收敛旧产物，不绕过限制再构建。

提交前重读完整调用链，修复范围内缺陷，运行相关回归和实际链路，核对 schema、证据及文档一致。
显式 `git add <本会话路径>`，检查暂存 diff，再提交完整单元；不跳过钩子、不夹带其他会话修改。
提交后核对 hash、文件列表和剩余工作区，阶段末再次运行资源普查。只宣称本次证据覆盖的范围，不自动推送。

旧 28 个 am2 测试目录完整证据已压缩到 `.artifacts/history/20261024-p2-temp-evidence.tar.gz`（约 10.3 MiB），
摘要清单同目录保存。历史文档里的 `/tmp/am2-*` 路径已回收，需要时先检查归档，不重建 VM 或展开全部旧测试目录。
