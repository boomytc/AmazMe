# Python 后端重构：部分完成

整个 Goal 未完成。下面是对照定稿完成定义的当前事实，不是结案。

记录时的 HEAD 是 `89dd0ac6d983ce2cd7cbad667d54e52ead2b8eba`。本文件和同一提交里的运行时检查还没有哈希；提交之后以 `git log -1` 为准。分支是 `dev`，没有推送，没有合入 `main`，没有 `v*` 标签，没有 GitHub Release，没有运行 `npm run release`。

## 阶段

1. P2 代码和 34 项自动验收：`9b83b083` 的两份安装包重跑通过。摘要是 `docs/python-backend-head-p2.json`。早先 `d5cefaf` 的 A/B 仍然有效。
2. P2 环境：2MiB 隔离卷 ENOSPC 有记录。宿主睡眠、物理断电没有真实证据，保持未验收。
3. P3：Web、Electron、TUI、CLI、RPC、SDK 已有 Python 契约上的实际使用记录，多数仍是部分通过。OAuth、真实供应商费用、cua-driver/TCC、真实 OpenSSH 和付费网页调用没有验收。
4. P4：移动目录、空格路径、受控 PATH 和进程级离线首启有记录。桌面预览 DMG 完成了 Developer ID、公证、staple 和 Gatekeeper。Python onedir 仍是 ad-hoc。旧 TS 业务入口还有引用，没有删除。

## 安装产物

| 产物 | 路径 | build_id 或身份 | 签名 |
| --- | --- | --- | --- |
| 历史 P2 A | `.artifacts/python-backend-p2/package-gbn32ffr/AmazMe Python 0.1.0` | `257b71973f69ed8fe2178ab41acddbb973360e44db507dc7c7ba7a1af6ddac5c` | ad-hoc onedir |
| 历史 P2 B | `.artifacts/python-backend-p2/package-r3e13r24/AmazMe Python 0.1.0` | `7f4e9d802bbe1be8a96748bfdd89bf677bf09811e44398a12b6c8bbbd143b2fb` | ad-hoc onedir |
| 当前源码 A | `.artifacts/python-backend-head/package-yboxdh3i/AmazMe Python 0.1.0` | `f3b24e92d590c7343c3d04a76b48e2dffe6d0e2142edb45980e74d56805c0cd8` | ad-hoc onedir |
| 当前源码 B | `.artifacts/python-backend-head/package-4qxl9x82/AmazMe Python 0.1.0` | `a9667286a889153a1d55d77d6e39c529d867a60d8d4b7a89868fc2b7e30be331` | ad-hoc onedir |
| 更新源 | `.artifacts` 中的 `package-fe7_msbu` | `a44cf603121570ffcb1037fcb331ba3bb6b22d106555ddda367aa7157e41a73e` | ad-hoc onedir |
| 更新目标 | `package-syyayj_m` | `0169b95e3e5f724e096d7a7fae3b5cf47c517c44d9ee41b097664514db9df06b` | ad-hoc onedir |
| 桌面预览 DMG | `.artifacts/python-backend-sign/desktop/AmazMe-0.3.4-macos-arm64.dmg` | 应用版本 0.3.4，不是 Python build_id | Developer ID，已公证并 staple |

A/B 的 34 项和 Chrome 6 项对应源码 `9b83b083`，不是更早的 `d5cefaf` 包。DMG 的钉住后 SHA256 是 `e0bfad05a4e6ff619d9ce862fd07c57f1fb1190928545c3e88a1ebf24fea84fb`。

## 签名和公证

细节在 `docs/python-backend-signing.json`。

- 登录钥匙串里当前有 1 个 Developer ID Application，属于 `release.env` 的团队。没有改用别的团队，也没有用 ad-hoc 顶替这次发布签名。
- 只读 history 成功，当时没有提交归档。
- `package-yboxdh3i` 的原 `amazme-backend` 仍是 ad-hoc，`TeamIdentifier` 为 not set。副本 `.artifacts/python-backend-sign/probe/amazme-backend` 使用 hardened runtime 和时间戳，严格校验通过，团队与配置一致。这份副本没有公证，也没有 staple。
- 现有 `scripts/package-desktop.mjs --dmg` 打出的预览包公证结果是 Accepted，提交 `cc84ac41-6d73-464d-a496-74914b94b9d9`。`stapler validate` 退出码 0，`spctl --assess --type open` 退出码 0。
- 这个 DMG 装的是 Electron 44.6.0、官方 Node v22.23.3、`@amazme/gui` 和 `@amazme/coding-agent`。它不是 Python 后端安装包，不能当作 Python 产品已经公证。

## 系统运行时检查

离线证明仍是 deny-default：公网 `1.1.1.1:443` 为 Operation not permitted，本机 `127.0.0.1:9` 为 Connection refused。带虚拟机的 seatbelt 改为允许默认，因为 deny-default 会让 Virtualization.framework 发不出沙箱扩展。它仍拒绝 `/usr/bin/python3` 和 Homebrew 的 node、docker、colima。包内同名程序可以执行。进程树另外拒绝任何包外的这些名字。

现场报告 `docs/python-backend-head-runtime.json`：源包 `package-yboxdh3i`，build_id `f3b24e92d590c7343c3d04a76b48e2dffe6d0e2142edb45980e74d56805c0cd8`，复制到带空格的 `bundle xq7p0mae`。两次 serve 的协议都是 `amazme-http/1`，`forbidden_runtime` 为空，pid 42759 和 42871 已退出。PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`。映像里的解释器是包内 `_internal/Python.framework`，不是系统 Python。

随后的包 `package-4vcvcbxo` 把 Node 和 QuickJS helper 放进安装目录，Codemode 不再调用 `shutil.which("node")`。`docs/python-backend-node-runtime.json` 记录了包内 Node、包内 limactl 上的 shell 和 MCP。

## 自动测试和客户端

- 本单元：`ruff check` 通过；`pytest backend/tests/test_relocated_runtime.py` 1 项通过。
- 先前 HEAD 包：`verify_p2.py --case all` 34 项 passed，报告摘要 `docs/python-backend-head-p2.json`。Chrome `verify_client.py` 6 项通过，页面错误为空，`.artifacts/python-backend-p2/client-jwdc18bu/report.json`。
- 没有在本单元重跑全量 pytest、pyright 或 `npm run check:workspace`。产品源码没有改动，改的是验收工具、测试和文档。
- 真实供应商、OAuth、OpenSSH、Linux 宿主、睡眠和断电没有新的通过记录。

## 文档

- 台账：`docs/python-backend-completion.md`
- 签名：`docs/python-backend-signing.json`
- 运行时：`docs/python-backend-head-runtime.json`
- 仍会进入旧 TS 运行时的入口：`docs/python-backend-ts-deps.md`

## 仍未验收

- OAuth 和真实供应商费用。没有凭据，不能把占位错误算作完成。
- 宿主睡眠、物理断电。不能用模拟代替。
- Linux 宿主，真实 OpenSSH，cua-driver 和 macOS TCC。
- 付费网页调用、用量账单、文件 artifact、周期定时规则、通用工作流、记忆向量。
- 浏览器地址不带会话和工作区时仍会选中第一项。
- 产品交互、print、JSON、RPC、桌面 `boot` 和 `amazme web` 不再进入旧 TS 运行时。`server` / `client` 和 `import`/`export` 仍在 coding-agent 源码里。已公证 DMG 还没按新打包脚本重做，所以那份产物里仍有 `@amazme/coding-agent`。引用还在，所以不删。
- Python onedir 没有 Developer ID 公证和 staple。已公证的是仍含旧 TS 宿主的桌面预览 DMG。
- 正式安装的 Codemode 已改用包内 Node。其他未打包的入口如果再从 PATH 找 Node，进程树检查会拒绝。Python onedir 还没有公证。
- 34 项矩阵对应 `9b83b083`，不是公证 DMG。

## 清理

这次 relocated serve 的 pid 42759、42871 已退出。没有为本单元的 profile 留下 `~/.amazme-vm` 目录。公证挂载已卸下。没有推送。

## 基线之后的提交

命名基线 `d5cefaf0` 不在下面的列表里。自它之后有 80 个提交：

- `0b73c826 feat(backend): 已完成的根任务可以分支且上下文不再混用`
- `14d40ed3 docs(backend): 把磁盘、睡眠和公证从 P2 代码门槛里分开`
- `1af60222 feat(backend): 归档会话时保留历史并拒绝新任务`
- `d4367119 docs(backend): 把会话归档记到验收台账`
- `8c9cee19 feat(backend): 压缩上下文时保留原消息并拒绝过期依据`
- `5196b23e docs(backend): 把上下文压缩记到验收台账`
- `2a81e20f feat(backend): 保存模型选择时不暴露密钥也不清空会话`
- `340af734 docs(backend): 把模型目录记到验收台账`
- `0e9053cd feat(backend): 让供应商请求走指定代理并带上请求头`
- `99a3de54 docs(backend): 把代理和请求头记到验收台账`
- `0ebbe957 feat(backend): 在授予目录内浏览并受检写入文件`
- `ee311fa9 docs(backend): 把工作区文件浏览记到验收台账`
- `9e2defe4 fix(backend): 让客户机文件工具拒绝越界链接`
- `cbb58845 docs(backend): 把客户机文件工具的链接约束记到验收台账`
- `6dcdc474 feat(backend): 在客户机里提供有界 PTY 并只按 waitpid 记录退出`
- `fcdf6d2b docs(backend): 把有界 PTY 记到验收台账`
- `77198601 feat(backend): 让 MCP 在批准后才进入受管客户机进程`
- `423c3174 docs(backend): 把受管 MCP 记到验收台账`
- `81b01860 feat(backend): 断线时保留远端 daemon 的未知调用并不重放`
- `447d7df7 docs(backend): 把远端 daemon 断连记到验收台账`
- `6319c3ff feat(backend): 只在脚本成功时提交 Codemode 状态`
- `183d96bb docs(backend): 把受控 Codemode 记到验收台账`
- `6fc70d54 feat(backend): 只在当前会话的持久历史里搜索`
- `d1e6350a docs(backend): 把当前会话历史搜索记到验收台账`
- `268556af feat(backend): 让插件经监督器登记并在活动任务期间拒绝更换`
- `a9402740 docs(backend): 把插件身份和受管入口记到验收台账`
- `efbda5d8 feat(backend): 把额外工作区映射到稳定的客户机路径`
- `341aa67a docs(backend): 把多工作区路径映射记到验收台账`
- `da0240c7 feat(backend): 只把当前工作区的匹配记忆注入模型上下文`
- `c8adf3e9 docs(backend): 把工作区记忆注入记到验收台账`
- `25fc14ed feat(backend): 在受检写入前保存文件检查点并只按当前摘要恢复`
- `60802476 docs(backend): 把文件检查点记到验收台账`
- `189a1304 feat(backend): 用单一调度按当地时间触发且不重复提交`
- `4820fd95 docs(backend): 把定时任务和夏令时去重记到验收台账`
- `e9bb34e7 feat(backend): 用独立子任务做有限次修正并在恢复时保持原阶段`
- `ab4384ca docs(backend): 把工作流的有限修正和阶段恢复记到验收台账`
- `4d30ac2f feat(backend): 关闭网页调用直到用户启用且不重放未知计费`
- `0ef539ba docs(backend): 把网页调用的凭据边界和未知计费记到验收台账`
- `fe732487 feat(backend): 按驱动报告换算桌面坐标并在缺少退出证明时停住`
- `9c31696d docs(backend): 把桌面坐标换算和清理证明记到验收台账`
- `b74e2d35 feat(backend): 用新格式保存项目反馈和分享且导入不覆盖已有会话`
- `a3f01623 docs(backend): 把新格式导入导出和分享去重记到验收台账`
- `318ea955 feat(backend): 打开管理面板时读取已保存的项目列表`
- `45aeb16f docs(backend): 记下管理面板会读取已保存的项目列表`
- `42db3788 feat(backend): 让模型的网页搜索和抓取走已有策略且未知调用不重发`
- `82cf6cf4 docs(backend): 把模型网页工具记到验收台账`
- `5de3d5c2 feat(backend): 打开分享后读取已保存的正文`
- `a671a473 docs(backend): 记下分享面板会读取已保存的正文`
- `244820ee feat(backend): 打开插件面板时读取已保存的插件`
- `0b793ba6 docs(backend): 记下插件面板会读取已保存的插件`
- `97f8fe67 feat(backend): 打开网页面板时读取已保存的策略`
- `cd79a1ac docs(backend): 记下网页面板会读取已保存的策略`
- `55b01735 feat(gui): 用包内 Python 后端启动桌面并在明确退出时关机`
- `a47b161d docs(backend): 记下桌面端会启动包内 Python 后端`
- `bef9f14a feat(gui): 用真实窗口核对包内 Python 的配对和退出`
- `498d1fa6 docs(backend): 记下真实 Electron 两次启动包内 Python 的结果`
- `77101bd5 feat(backend): 让命令行、RPC 和 SDK 写明工作区，松开绑定不取消任务`
- `bc375d04 docs(backend): 把命令行、RPC 和 SDK 记到验收台账`
- `d4367e22 feat(backend): 让终端界面写明工作区，离开时只松开绑定`
- `9a6a3fca docs(backend): 把终端入口的两次启动记到验收台账`
- `20c145fc fix(backend): 让桌面驱动只接受对象形式的协议消息`
- `eae6735c feat(backend): 锁定两个终端同时在线时离开一个不会取消另一个`
- `b6af0689 docs(backend): 把两个终端同时在线的隔离记到验收台账`
- `6624dc52 docs(backend): 记下签名身份和配置团队不一致`
- `d1cee8d8 feat(coding-agent): 让交互界面在写明 Python 宿主后只松开绑定`
- `26ffe5ea feat(backend): 用当前冻结包重跑命令行、RPC、SDK 和终端`
- `329a86ca docs(backend): 记下冻结包上的命令行和交互入口`
- `ac0c7f1d feat(coding-agent): 让默认交互入口使用 Python 宿主`
- `eb67ac91 docs(backend): 记下默认交互入口改接 Python 宿主`
- `2e34efbd feat(coding-agent): 让打印、JSON 和 RPC 走 Python 宿主`
- `6e0d96dc feat(gui): 让每个桌面窗口写明会话和工作区，关窗不取消任务`
- `7b589318 docs(backend): 把桌面多窗口现场记到验收台账`
- `b76ad5df feat(backend): 让挪到含空格路径的安装包在受控 PATH 下启动`
- `2c16a4bc docs(backend): 把安装目录移动的提交记到验收台账`
- `b64769e7 feat(backend): 记当前安装包的提交、历史加载和取消退出时间`
- `b47724cd docs(backend): 把运行计时的提交记到验收台账`
- `dcfbc193 docs(backend): 记下仍会进入旧 TS 运行时的入口`
- `9f2cd640 feat(gui): 让桌面更新按 Python 冻结、验证和激活进行`
- `9b83b083 docs(backend): 把桌面更新协议的提交记到验收台账`
- `89dd0ac6 feat(backend): 用当前源码的两份安装包重跑生命周期并拒绝出站连接`
