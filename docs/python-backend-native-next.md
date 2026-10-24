# 本机优先阶段交接

2026-10-24，分支 `dev`。模型驱动 MCP、Web 终端画面、Electron 源码进程、`amazme-backend tui`、print/JSON CLI、RPC、Python SDK 和默认交互画面已按各自范围验收。产品能力和安装仍未完成，整个 Python 重构尚未完成。
现行设计只有 [本机优先方案](python-backend-plan.md)；旧 P0/P1/P2 的 VM 方案与验收数字仅保留历史意义。

## 已形成的提交单元

| 单元 | 提交 / 定位 | 运行证据 |
| --- | --- | --- |
| B 本机 shell、文件、审批、检查点 | `b6c2d7a26e1dd769960313ab22bd30af47836751` | [证据](python-backend-native-evidence.json)：Chrome、真实 DeepSeek、本机文件副作用及恢复 |
| C1 会话 PTY | `de851ab7e5ec4af47c147ba2455abcca941394d2` | [证据](python-backend-native-terminal-evidence.json)：Chrome、resize、重连、输入去重、真实进程崩溃 |
| C2 本机 MCP 服务与手动调用 | 包含本文件的 `feat(backend): 让本机 MCP 服务保留审批与不确定调用事实` 提交 | [证据](python-backend-native-mcp-evidence.json)：官方 SDK 服务、Chrome、审批丢回执、结构化结果、取消和崩溃 |
| 资源普查 | `b26d1d47c3154ad768173f6026effa9b0618b344` | 隔离 Host 的 serve/supervisor 被标为临时泄漏，关闭后所属进程退出；该次 build_id 未变 |
| C2 模型驱动 MCP | `05db362d5fde93b204564edcd4b2418d3bdd407a` | [证据](python-backend-native-mcp-model-evidence.json)：DeepSeek 选择本机探针，拒绝无副作用，结果回到模型 |
| Web 终端画面 | `951e73c76fa7d2d685fe21d4cdc93069ffccc866` | [证据](python-backend-native-terminal-screen-evidence.json)：归还 32 KiB 窗口、256 KiB 滚动记录、页面解释转义；Chrome 看到命令输出和 resize |
| Electron 源码进程 | `52daf512d10fa5d76b46300816ca7d27c60e451f` | [证据](python-backend-native-electron-evidence.json)：真实 Electron 装载当前源码后端；终端、审批、检查点、MCP、双窗口和退出归属 |
| TUI | `b55c94950e0bd8a38953ac055b0ee88f7880e614` | [证据](python-backend-native-tui-evidence.json)：真实 `amazme-backend tui`；显式审批、终端、文件、检查点、MCP、离开不关闭、再次进入后显式关闭 |
| CLI print/JSON | `b346797bac2c9c97af06e2cf8b8561f8403fc8bb` | [证据](python-backend-native-cli-evidence.json)：包入口 print/JSON 进程；显式审批、终端、文件、检查点、MCP、离开不关闭、再次进入后显式关闭 |
| RPC | `ad7c433e95b9c0c07af314cbca8e6ac8eee1566a` | [证据](python-backend-native-rpc-evidence.json)：`--mode rpc` 进程；显式审批、终端、文件、检查点、MCP、松开绑定不关闭、显式关闭 |
| Python SDK | `8bdf019c7e34e13d91bb8f5d55a516b194acb25a` | [证据](python-backend-native-sdk-evidence.json)：独立进程里的 `sdk.Client`；显式审批、终端、文件、检查点、MCP、进程退出不关闭、显式关闭 |
| 默认交互画面 | `8ca7fd1814b1e34fa7475f49fd2485526e03a430` | [证据](python-backend-native-screen-evidence.json)：包入口交互进程；显式审批、终端、文件、检查点、MCP、离开不关闭、再次进入后显式关闭 |
| 多工作区本机目录 | `7ab9cb32ac900f9848d20d237558614b8a9959e5` | `backend/tests/test_workspaces.py`：会话 shell 和终端进入授予的本机目录；取消授予后不再执行，原文件仍在；页面显示绝对路径 |
| 命令行决定 | `905f83e1356fdc868786b9b10427e1f7b62e140f` | `backend/tests/test_client.py`：`client decide` 在连接前拒绝含糊决定；拒绝无副作用；批准只写一次；再次决定返回原结果；提交文本「批准」不是决定 |
| 供应商密钥更换 | `1f02bba43651453df31fb1fdf3fad74d472eb5e8` | `backend/tests/test_model_catalog.py`：代际冲突和更新冻结不覆盖已保存密钥；清除后不创建供应商连接；页面更换后清空输入 |
| 导入前核对工作区 | `8b76f8e4954643f381c6517e673a0bfb8c07a129` | `backend/tests/test_management.py`：缺工作区或项目时不写入；授予本机目录后两个会话和项目一起导入 |
| 会话文件工具目录 | `896e3822b4edf6d40d5845b4485e39eeb7a0a379` | `backend/tests/test_workspaces.py` 与 `backend/tests/test_tool_checkpoints.py`：相对路径写入授予目录；显式 grant/名称 仍指向该目录；准备摘要对上该目录里的原文 |
| 导入反馈必须指向会话 | `f09883c506864f67f84fe980bae054bc33e91d5c` | `backend/tests/test_management.py`：反馈指向未知会话时不写入项目、会话、显示名或反馈；同一份导出里的会话可以带上反馈 |
| 分支失败不留项目关联 | `89ac09663624d28043ddc6d1e5d41525a6eaf222` | `backend/tests/test_session_branch.py`：工作区已取消时不分出新会话；复制失败后项目关联仍只指向父会话 |
| 侧栏显示本机目录 | `6e42934df10623807720a5c6931883a847a85815` | `backend/tests/test_workspaces.py`：未选会话时侧栏是「本机工作区」；选中会话后显示该工作区的本机目录；文件区切到另一个授予目录时侧栏不变 |
| 终端和 MCP 跟随会话目录 | `426cc44a6a7fee16b201e68746637caf7d1685c7` | `backend/tests/test_workspaces.py`：文件区停在另一个授予目录时，新建终端和连接 MCP 仍提交空工作区，由宿主按会话目录打开 |
| 未知会话不进入主工作区 | `2d1a85602d50eebc837bc2df3c8cbd7e6b2d7b02` | `backend/tests/test_workspaces.py`：没有这条会话时，终端、MCP、脚本、远端和插件调用都不联系监督器 |
| 监督器拒绝缺失的会话行 | `ccfbaf38fd0e143176b13b38051f029d84d6db8a` | `backend/tests/test_workspaces.py`：宿主库已有会话表而没有这一行时，空工作区终端和 shell 在写入主目录之前拒绝 |
| 写明工作区仍核对会话行 | `c3e30b66876ca4b428bd37f0c488becef58e5d7b` | `backend/tests/test_workspaces.py`：写明 primary 的终端和 MCP 在会话行缺失时拒绝，执行目录不会创建 |
| 分支沿用会话开关 | `ec79f2252a91154b64d70b64feb9999da237aa63` | `backend/tests/test_session_branch.py`：子会话得到父会话的网页和桌面开关；已发出的调用和被挡住的桌面状态留在父会话；地址带账号时不分出新会话 |
| 取消授予后不定时提交 | `31507d9cf5b940589b8e8cb7d227ad0c65250bd3` | `backend/tests/test_automations.py`：授予取消后到期任务记为未知且没有投递；不能再新建；记录工作区与会话不一致时也不提交；原文件仍在 |
| 取消授予后不打开工作流 | `7478910efcf4b6cf5623da0c1b60160818e16988` | `backend/tests/test_workflows.py`：未打开过的会话不会建库；已有工作流可重读、冲突、通过、重放和取消；新的修正子任务不写入 |
| 记忆不送出供应商密钥 | `702b529fc95e67895703a87418d9f36c98aed75a` | `backend/tests/test_memories.py`：含当前密钥的记忆拒绝保存且响应不含密钥；已落盘的这类记忆不进入模型输入；不含密钥的记忆仍注入 |
| 出站正文不带供应商密钥 | `314ff6e4d9a57e43fa60f70ffe58bddaa26fad72` | `backend/tests/test_automations.py`、`test_workflows.py`、`test_web_tools.py`：新的定时正文和工作流检查拒绝保存；已到期的密钥正文不投递；网页查询和地址不发送且不占调用；原话含密钥时不附带 |
| 受控子进程不继承密钥环境 | `0388f3c9453ab706d5f5d4242b24f2e020f7274d` | `backend/tests/test_plugins.py`：插件门、Codemode 和桌面驱动只拿到工具环境 |
| 已排队的工作流检查不带出密钥 | `1b9b909237ffd823d7284f05027ed74803ce03db` | `backend/tests/test_workflows.py`：含当前密钥的已排队检查不进入模型；用户本轮输入仍发送 |
| 压缩不带出供应商密钥 | `544ed2328e3175995b5255906b9887b8936c8cb5` | `backend/tests/test_session_branch.py`：原文含当前密钥时不请求摘要；返回含密钥的摘要不写入；已落盘的这类摘要不进入下一轮 |
| 产品入口没有 destroy-vm | `3423c4e95e63d3ffa22820713e965c6fce85adf1` | `backend/tests/test_runtime_cleanup.py`：该命令被拒绝且不创建 profile。桌面更新测试不再调用它 |
| 未知远端命令不另开一次 | `40593c10f1d7e3c3b2fda06e97043f990c5d19de` | `backend/tests/test_remote.py`：结果未知时页面沿用同一调用和命令；改命令不会发送 |
| 未知脚本和插件调用不另开一次 | `a127961389dcb3493e6ade2e5ded4e529fe4ce1a` | `backend/tests/test_codemode.py`、`backend/tests/test_plugins.py`：结果未知时沿用同一运行或调用；改来源或文本不会发送，取消打到这次脚本 |
| 未知网页查询和桌面点击不另开一次 | `7c10958172a12f600da369a08c60131263bac6fe` | `backend/tests/test_web_tools.py`、`backend/tests/test_computer_use.py`：结果未知时沿用同一调用或动作；改查询、画面或坐标不会发送 |
| 未知压缩不再次请求模型 | `96f9bd3dead41d5790fcc92d76d628e4ad74d055` | `backend/tests/test_session_branch.py`：已写好或仍占位的同一次压缩不再请求模型；页面沿用同一次编号 |
| TUI 未确认输入不另写一次 | `4f046d51ad10dcb807a2902179a5b6becd4cfdff` | `backend/tests/test_tui.py`：同一次进程里未确认的 `/pty` 沿用同一编号；改内容不发送；`/pty-ack` 不重放 |
| 交互画面未确认输入不另写一次 | `a1b7f8d36c1a260e2c8655e2e97d044113097ff5` | `packages/coding-agent/test/python-screen-terminal.test.ts`：同一次画面进程里未确认的 `/pty` 沿用同一编号；改内容不发送；`/pty-ack` 不重放。每次 print 命令仍是新进程 |
| macOS 临时目录里的后端不是常驻服务 | `ce4da8bfdc69f815721a945e4dcc54171351bcee` | `backend/tests/test_resource_census.py`：`/var/folders/.../T` 与 `/private/var` 别名上的 profile 记为泄漏，目录不在也一样；`C` 缓存和用户 profile 仍是 observed。画面测试先停止所属进程再删目录 |
| 工作区无法核实时不启动 | `74a0786e4b39028bf80688275ca62c8af16d0ae2` | `backend/tests/test_workspaces.py`：库缺失、表缺失、损坏或工作区为空时，shell、终端和 MCP 不启动、不写文件。已打开的终端仍可读取和关闭 |
| 终端增量不再切开非 BMP 字符 | `b9d61ca2efdc7765a0beae496b69153823934213` | `backend/tests/test_pty.py`：输出游标按 UTF-16 码元计数，和页面切片一致。先显示 A 再增量显示 A🙂 不会留下孤立低代理项。CLI 失败重试沿用同一输入编号；成功或核对之后，同一命令是新操作 |
| Electron 丢回执后沿用同一输入 | `a5bbecde711185fda5236fe20027d1a7a77ad97c` | `backend/tools/verify_electron.py`：真实 Electron 进程里第一次输入已到达服务器，回执被丢掉；再次提交沿用同一编号，文件仍是一个 `x` |
| 冻结后不开始新的本机执行 | `5990074af92b0efd5e6a47348990d1e7bf7cac61` | `backend/tests/test_native_terminal.py`、`backend/tests/test_execution_p2.py`：冻结后新的 shell、终端、MCP 和终端输入不产生副作用；同一输入和已完成的 shell 仍返回原结果；终端可关闭，解冻后新终端可以运行 |
| 冻结后仍可查询已完成的脚本和插件 | `053a664e847d5976029de89d2dbfac976663edde` | `backend/tests/test_execution_p2.py`：冻结后同一脚本和插件调用返回原结果；新的运行和调用不写入 |
| Chrome 页面插件丢回执不另写一次 | `c319173574a5d4632ca321bf884b5c38e71313b2` | `backend/tools/verify_plugin_page.py`：真实 Chrome 登记固定 stamp 插件，回执丢失后同一调用只追加一行。这不是 Codemode，也不是任意第三方插件 |
| Chrome 页面脚本丢回执不另跑一次 | `ff746083829a31cf8ddadcf16f2a40703101cf52` | `backend/tools/verify_code_page.py`：真实 Chrome 用包内布局的 Node 跑脚本；回执丢失后同一运行的状态仍是 n=1 |
| 反馈和分享丢回执不另存一次 | `646701c4caeb456587ff26e8f2798fd3c9b7b8d2` | `backend/tests/test_management.py`：结果未知时沿用同一反馈或分享编号；反馈改内容不发送。成功之后再分享是新的一次 |
| 记忆和检查点丢回执不另存一次 | `27c9732113dc28e07bae6b9ab215651b72426aab` | `backend/tests/test_memories.py`、`backend/tests/test_checkpoints.py`：结果未知时沿用同一记忆或检查点；改内容或改文件不发送。成功之后再保存是新的一次 |
| 项目和新会话丢回执不另开一次 | `cedbf96746d01037c9bd98f77d6d94dc6d561a42` | `backend/tests/test_management.py`：同一会话编号再次创建返回原行；编号相同但标题不同则拒绝。页面结果未知时沿用同一项目和会话编号；改名称不发送。成功之后再创建是新的一次 |
| 页面终端改用 xterm 缓冲区 | `96a337c6a555b4da6bc907e389e45ec3ffd5092d` | `backend/tests/test_pty.py`：备用屏幕退出后不留下备用内容，宽字符按列换行，颜色序列不出现在正文里。非 BMP、组合字符和增量重同步仍按 UTF-16 游标 |
| 页面打开 xterm 画面 | `d9ad5d197d5e81acb63cb285e25ce8b97121618a` | `backend/tests/test_pty.py`：当前终端把彩色文字画成 `xterm-fg-1`。键盘输入仍走原来的编号。鼠标没有交给 PTY |
| Electron 页面打开同一 xterm 画面 | `c67440d67ffd815bcb2fe136c2c0f47cb14292f6` | `.artifacts/native/electron-vv1fjgl1/report.json`：真实 Electron 进程里红色 `RED` 画成 `xterm-fg-1`。丢回执、resize、刷新、关闭、审批、检查点和 MCP 仍按原范围通过 |
| 终端应答和鼠标走同一输入编号 | `37fbca34ddd111bb5b65cc36e30405507386460b` | `backend/tests/test_pty.py`：光标位置应答丢失后再次上报沿用同一编号。`.artifacts/native/terminal-55t23f71/report.json`：Chrome 里点击画面后，SGR 鼠标上报进入终端输入 |
| 更新冻结后仍能读取已完成的脚本和插件 | `c15dddc8ab81bf353e9d522b9c5d6963730c4e46` | `backend/tests/test_workspaces.py`：监督器冻结编号与更新一致时，已完成的脚本和插件调用返回原结果；新的运行和调用拒绝。监督器尚未冻结时也不开始 |
| DeepSeek V4 Pro 按已发布目录计价 | `ba7218883758e0350968912eb8bbae549085adaf` | `backend/tests/test_usage.py`、`backend/tests/test_model_catalog.py`：`deepseek.json` 里的两个模型都有微美元单价，页面目录可以选 V4 Pro。其他供应商仍不计价 |
| 当前源码打成一份本机 onedir | `84430ec64cfea109f3da4f89bcda0ff2dd9abeb0` | `.artifacts/native/package-rot666v1/AmazMe Python 0.1.0`：154 个文件，163084366 字节，冻结 `build_id` `fbd65a7173b7463f63e75e63bdc5506195aeb600a8be9d247d93c0a68506f07e`。启动后的 `build_id` 与清单一致，页面模式是 installed，并提供 xterm 脚本。签名是本机 ad-hoc，不是可分发 DMG，也没有公证 |
| 当前包在空格路径和错构建下启动 | `5249ecc1b43247f3e073244e9348a5b2831807a9` | 同一份包用 `PATH=/usr/bin:/bin:/usr/sbin:/sbin` 启动。可执行文件、profile 和工作区路径都含空格。错的 `x-amazme-build` 得到 `stale_client_binding`，正确构建创建了会话。`stop` 打印 `services stopped`。这不是断网证明，也不是公证 |
| 当前包在进程出站被拒绝时首次启动 | `5c0a5f878d7609b8716e0bd7f3f9ffab88768250` | 同一份包。seatbelt 拒绝 `1.1.1.1:443`，本机 `127.0.0.1:9` 仍是连接被拒。然后在这个限制里完成 init 和 serve，`build_id` 与清单一致。`stop` 打印 `services stopped`。这是进程出站限制，不是拔掉网线 |
| 更新准备好后新的脚本不再要求重试 | `6dfc6ac6f9a3392f3bd949e1ddd68e75f9eb7400` | 监督器已退出时，新的脚本返回 `update_prepared`。准备更新到另一个构建后，新脚本得到 `update_prepared` |
| 当前包改为 Developer ID 和 hardened runtime | `3d0045c38c3ec8d0985da485c3ef4617dbefe0cb` | `package-mnk7cmvu` 的 69 个 Mach-O 已签名。`codesign --verify --strict` 通过，flags 为 runtime。签名后清单 `build_id` 是 `40b5c6059646f8141ecbd80ba2ee1687543993cfb2f34e62d5186d97878afb10`，启动身份与清单一致。Gatekeeper 评估是 `rejected`，`source=Unnotarized Developer ID`。还没有公证和 staple |
| 公证历史没有提交成功 | `505de532a83a731bccd1ce4117a574b6e5720522` | 只读查询 `notarytool history` 时，`appstoreconnect.apple.com` 返回的证书签给了 `iadsdk.apple.com`。没有提交归档，也没有关闭证书校验 |
| 更新已退出监督器时终端输入不再要求重试 | `70a9140607d4eada1f504af323bc799809358b99` | `backend/tests/test_workspaces.py`：更新进行中且监督器连接失败时，终端输入返回 `update_prepared`，不是 `runtime_recovering` |
| MCP 目录变更后重新读取 | 包含本文件的提交 | `backend/tests/test_native_mcp.py`：`tools/list_changed` 替换目录后，旧 schema 的批准不发出；读取失败保留上一份并拒绝新调用；已完成调用不重放 |

没有推送、合入 main、打标签或发布。手动 MCP 源码 build_id 为
`10bfc410a56b2b5026aa151310afd5a06eeece762131a38398bf33cd1d7692a3`。
当时全套 456 项通过；Ruff、Pyright、wheel/sdist、工作区检查通过。那次 MCP 运行未调用付费模型。
这 456 项包含当时尚未提交的资源检查测试，不能把它们说成已经进入手动 MCP 提交。
模型驱动 MCP 的源码 build_id 为 `a84da7c3b4b8ea555cc12a4a096a2fd306fe76ae46797e70606e16d1fd1e364b`。
该单元最终源码上后端测试 475 项通过；Ruff、Pyright 和工作区规则通过。真实模型证据只覆盖隔离探针上的选择、拒绝和结果回传。
终端画面的源码 build_id 为 `f64fe5ec94e95dbaff3e431011bdd9a0454c854daa90c62ba9cb13aa6f506537`。
该单元最终源码上后端测试 477 项通过；Ruff 和 Pyright 通过。Chrome 证据只覆盖 Web 上的一条本机 shell。
Electron 源码进程使用同一 build_id：桌面启动器指向当前检出的 Python 模块，没有使用冻结包。
TUI 的源码 build_id 为 `936905f85b7af4fc2e260250bd813cff78546d25b18cf396419e116f04ae9738`。
TUI 改了会话客户端，所以这个 build_id 与终端画面不同。那次证据使用 faux，不代表真实模型又跑过一遍。
CLI 没有改 `backend/src`，源码 build_id 仍是上一行。证据使用包入口 `packages/coding-agent/dist/bundle/cli.js` 和 faux，不代表真实模型又跑过一遍。
RPC 扩展了同一宿主上的调用，源码 build_id 为 `763a4e6d956f9653e92a299f0f4a50b83526510c0ce74a3dec9d5222cbfc45c4`。该单元后端测试 478 项通过；Ruff 和 Pyright 通过。证据使用 `--mode rpc` 和 faux，不代表真实模型又跑过一遍。
SDK 没有改 `backend/src`，源码 build_id 仍是上一行。证据是独立 Python 进程调用 `amazme_backend.sdk.Client`，使用 faux，不代表真实模型又跑过一遍。
默认交互画面也没有改 `backend/src`，源码 build_id 仍是 `763a4e6d956f9653e92a299f0f4a50b83526510c0ce74a3dec9d5222cbfc45c4`。证据使用包入口 `packages/coding-agent/dist/bundle/cli.js` 和 faux，不代表真实模型又跑过一遍。
多工作区没有改 `backend/src`，源码 build_id 仍是上一行。
命令行决定改了 `client decide`，源码 build_id 为 `67fc998cc3f5ef502f4ea6b41bf1549363f82224805fdd4ff2cc47bf3996c8b0`。证据是真实 serve 上的 faux shell 和本机探针，不代表真实模型又跑过一遍。
供应商密钥更换的源码 build_id 为 `2a82d653260c3aba258a9ffcf2ba54e3604ff9b6aa911f384bcdaa2d1d12c3e4`。证据没有调用真实供应商，也不包含 OAuth。
导入前核对工作区的源码 build_id 为 `915ffb82fdc4b7393f81d82de658692e18bf1b8e21e6143fa89b22e445ca989b`。缺工作区时不写入；授予本机目录后两个会话都导入。
会话文件工具的源码 build_id 为 `361083b427fb478b8323d36360639f0862057b4fb2d5ada15c7a85771863224b`。相对路径写入授予目录，显式 grant 路径仍指向该目录，准备摘要对上该目录里的原文。
导入反馈核对的源码 build_id 为 `3952bd14fe648dc0621ea0d9b091327e85a1c89ca36c176d2a39e9490d629669`。反馈指向未知会话时不写入；同一份导出里的会话可以带上反馈。
分支失败清理的源码 build_id 为 `baa900e81cb64fd18f962a4f41ef51b67cfbcc756928f9f5b4ebd27c4b7cacc6`。工作区已取消时不分出新会话；复制失败后项目关联仍只指向父会话。
侧栏显示本机目录的源码 build_id 为 `0096df0a5f263b72c380676377d14b96d11a3b6dc2855e01a7295f3a92ab61b3`。选中会话后侧栏显示该工作区的本机路径；文件区浏览另一个目录时侧栏不变。页面测试使用 happy-dom，不是另一次 Chrome 验收。
终端和 MCP 跟随会话目录的源码 build_id 为 `f49df66d5c14615ed2f806e7598be4d82afd278cd061b8d682d92fcf0a738d62`。文件区停在另一个授予目录时，新建终端和连接 MCP 仍提交空工作区。页面测试使用 happy-dom，不是另一次 Chrome 验收。
未知会话不进入主工作区的源码 build_id 为 `2a33e729171c47466dacf2982b68ec9d011dc4d6e220bff9b6aae3a6e91ecabb`。没有这条会话时，终端、MCP、脚本、远端和插件调用都不联系监督器。已有会话仍会继续打开。
监督器拒绝缺失会话行的源码 build_id 为 `f72091af61e53d0319c34ce6beeae58a24eaf79ab185fec746e22bd23281fc89`。宿主库已有会话表而没有这一行时，shell 和空工作区终端不会写入主目录。当时库文件或会话表还不存在时，监督器单测仍把目录当作 primary；这个放行已经取消。
写明工作区仍核对会话行的源码 build_id 为 `bda5082f9311adea67b4087c2e4830b1b749fb9bf63cb1744980458aca513f00`。写明 primary 的终端和 MCP 在会话行缺失时拒绝。会话存在时，写明的名称仍指向那个授予目录。
分支沿用会话开关的源码 build_id 为 `fe0dad4d3b59706cc091aa04c7e3809fa56714808de7411d1fe78909988b2078`。子会话得到父会话的网页和桌面开关。已发出的网页调用和被挡住的桌面状态留在父会话。地址带账号时不分出新会话。没有真实付费调用，也没有读 macOS TCC。
取消授予后不定时提交的源码 build_id 为 `5a984e25943bb553fa121ded4ed6365cb4f57bd91a6155741f95d3b9cfe4925e`。授予取消后到期任务记为未知，不写入投递。不能再新建。记录里的工作区与会话当前目录不一致时也不提交。原目录里的文件仍保留。这不是页面里的另一次验收。
取消授予后不打开工作流的源码 build_id 为 `ddea02f76b2701c9385029d0d6b16a464760db8644f005706eaa132ec589815f`。未打开过的会话不会建库。已有工作流可重读、重放原结论、通过或取消。新的修正子任务不写入。主目录上的工作流仍可打开。这不是页面里的另一次验收。
记忆不送出供应商密钥的源码 build_id 为 `333eabf850c4450a97dd1309b32cba6a5a25128d7e122646c9a56d32e3cd6ad3`。含当前密钥的新记忆不会落盘，错误文本不含密钥。已经落盘的这类记忆仍留在库里，模型输入里没有它。不含密钥的记忆仍注入。更换密钥后，只含旧密钥的记忆不在这次检查里。
出站正文不带供应商密钥的源码 build_id 为 `5273ae98116ebd3250f7b0999d86365039da211b716edfa1b33de17871282ac1`。新的定时正文和工作流检查含当前密钥时拒绝，错误文本不含密钥。已经到期的这类定时任务记为未知且不再投递。网页查询或地址含当前密钥时不发送，也不占用调用。原话含当前密钥时不附带原话。已经排队且含当前密钥的工作流检查不会进入模型，该子任务记为未知。用户本轮输入仍会发送。这不是真实付费调用。
已排队工作流检查不带出密钥的源码 build_id 为 `9238cae2bf06df12abca0aa6311b22ae9e5beacda10d8aa850e2ba896a74bea6`。检查正文仍可重读。更换密钥后，只含旧密钥的检查不在这次检查里。
压缩不带出供应商密钥的源码 build_id 为 `dcb80f58d549076adc4c9582dbc3a06e005105ad9a529dedadebc85fb95a2142`。原文含当前密钥时不请求摘要。返回的摘要含当前密钥时不写入，原消息保留。已经落盘且含当前密钥的摘要不会进入下一轮模型输入。用户本轮不同的原文仍会发送。这不是真实供应商调用。
插件门、Codemode 和桌面驱动只拿到工具环境。供应商密钥、控制令牌和 SSH agent 不传给这些子进程。这不是真实 TCC，也不是任意第三方插件。源码 build_id 为 `64a11ff6f92ffda56ce808430dcb243eaa934a41f8ffae2d7ebe79294c6ba9b1`。

资源普查命令只报告，不按进程名发信号。用户主目录里的常驻服务保持 observed。macOS 用户临时目录 `/var/folders/<两级>/T` 和 `/private/var` 下的同一路径也是临时 profile，目录已经不在仍按启动参数归类；`C` 缓存目录不是泄漏。打包和运行器只删除自己目录中没有进程引用的超限产物；VM 目录和 `am2-*` 临时目录未确认前不删，也不为此安装或启动虚拟机。
下次再跑已有两份记录的运行器时，会让出该前缀最旧且无人使用的一份：`run-y5ei8l8q`、`mcp-xi0hnry9`、`client-160ayfgl`、`electron-l7nfl4tr`、`tui-16drl4_s`、`cli-0wllgxmx`。这次 Electron 运行又释放了 `electron-o04d4rq_`，当前 Electron 证据是 `electron-vv1fjgl1`，这次释放了 `electron-wiplc67v`。下一次 Electron 运行会先让出 `electron-uamesscf`。台账引用的较新目录仍留下。终端画面已释放 `terminal-err1kda9`。这次终端运行释放了 `terminal-atacoq7o`，当前 Chrome 证据是 `terminal-55t23f71`。这次运行释放了 `terminal-3i__hs0x`。`terminal-ybjwwdcv` 仍在，下一次终端运行会先让出它。Electron 这次已释放失败的 `electron-vntpwy9j`。`tui-m55jjevc` 是 TUI 证据，下一次 TUI 运行会先让出更早的 `tui-16drl4_s`。`cli-xc19exkk` 是 CLI 证据，下一次 CLI 运行会先让出更早的 `cli-0wllgxmx`。`rpc-ng488hhe` 是 RPC 证据。`sdk-wfo8x_to` 是 SDK 证据。`screen-27sf22xi` 是这次默认交互画面证据。

## 剩余执行顺序

1. **其余客户端实验。** Web 终端画面、Electron 源码进程、`amazme-backend tui`、print/JSON CLI、RPC、Python SDK 和默认交互画面已按各自范围验收。输出游标按 UTF-16 码元计数，页面按同一长度截取增量。TUI 和默认交互画面在当前进程内沿用未确认的 `/pty` 输入。CLI 把未确认的输入编号写在代理目录里，失败重试沿用它；成功或 `/pty-ack` 之后，同一命令是新操作。Electron 页面在回执丢失后沿用同一输入编号。RPC 和 SDK 使用调用方传入的输入编号，没有另一套账本。监督器冻结后，新的 shell、终端、MCP 和终端输入不会开始；同一输入和已完成的调用仍返回原结果，已打开的终端仍可读取和关闭。各客户端没有重跑冻结，也没有重跑杀掉 worker 或监督器。页面打开 `@xterm/xterm` 5.5.0 的 DOM 画面，颜色由样式类绘制。键盘、光标应答和已打开的鼠标跟踪都走原来的输入编号。TUI、CLI、RPC 和 SDK 不使用这个页面终端。
   这些实验仍要按同一契约补证。先追踪已有实现，不另建一套业务运行时。
2. **按真实需求补齐产品功能。** 多工作区已在本机目录上核对：会话 shell、终端和没有 grant/ 前缀的文件工具进入授予目录，文件区显示当前浏览目录，侧栏显示当前会话的本机目录，取消授予不删文件。页面新建终端和连接 MCP 不跟随文件区。没有对应会话时，这些启动不会落到主工作区。宿主库已有会话表而缺少这一行时，监督器不改用主目录；写明工作区名称也会先核对会话行。库文件不存在、会话表不存在、库损坏或工作区为空时，新的 shell、终端和 MCP 也不启动。已经打开的终端仍可读取和关闭。会话存在时，显式 grant/名称 仍指向那个目录。
   `amazme-backend client decide` 已核对显式批准和拒绝。`client submit` 仍只等待终态。
   供应商密钥可以更换和清除。OAuth 仍未做。导入会先核对每个会话的工作区，以及反馈指向的会话。缺任何一项时不写入。分支在工作区已取消时拒绝，复制失败不留下项目关联。分支会复制网页和桌面开关，不复制已发出的调用或桌面运行状态。授予取消后，到期的定时任务记为未知且不再提交，也不能再新建。也不能再打开新的工作流或追加修正子任务。记忆正文含当前供应商密钥时不会保存，也不会放进模型上下文。定时任务、工作流检查和网页查询同样不会把当前密钥发出去。已经排队且含当前密钥的工作流检查也不会进入模型。压缩原文或已落盘摘要含当前密钥时也不会进入模型。插件门、Codemode 和桌面驱动只继承工具环境。产品入口没有 destroy-vm。桌面更新测试不再调用它。历史 `verify_p2.py`、`verify_relocated_bundle.py` 和 `measure_runtime.py` 仍写着这个命令，不要运行。页面上一次远端命令结果未知时，沿用同一调用和命令；改命令不会另开一次。这不是真实 OpenSSH。脚本和插件调用结果未知时也沿用同一次，改来源或文本不会另开，取消打到这次脚本。网页查询和桌面点击结果未知时同样沿用同一次，改查询、画面或坐标不会另开。这些仍是页面测试，不是付费网页或真实 TCC。压缩先占住这次编号；已经写好或仍未知时不再请求模型，页面也沿用同一次。明确没有发出去的失败会放开占位。这不是真实供应商调用。当时源码 build_id 为 `af412d8fef8b13f875eb98a29654d5b8f773f87ab33faa0fab3bb56a15daa140`。TUI 和默认交互画面的未确认输入只在当前进程内沿用同一次编号。CLI 每次 print 仍是新进程，下一次命令会另写一次。工作区无法核对时不再进入主目录，那次源码 build_id 为 `e772f042b514935ca67f765759285f4a57a432f5252280dad8db7667fea3acd4`。终端增量游标改成 UTF-16 码元后，源码 build_id 为 `23ad63ddfefd0ee93b8b9529cc1167609a2aac3763ea8b62a0097324ec467a51`。监督器冻结不再开始新执行后，源码 build_id 为 `9294aab520d17d31bbfd4aacf4bae677440532b6eeff070d94f0f756eb186037`。已完成的脚本和插件调用在冻结后仍可查询。脚本和插件查询那次的源码 build_id 为 `515059421630301386140108996f6bf41af94f5d19b0834e0ebf7bb6dd3259ce`。反馈和分享沿用未确认编号后，源码 build_id 为 `f1a2ef709269b40214e8980080046a1851e810f0500f0c33a70a7dba28bdf99c`。记忆和检查点沿用未确认编号后，当前源码 build_id 为 `fbf1f95ae71aaa9e5ab09126d93fdea19fd3b732c45d97c4f5bc3a5b1145f3f3`。
   真实 SSH、computer-use 的系统权限、记忆、工作流、定时任务、网页工具及分享仍要逐项区分。固定 stamp 插件和 Codemode 已在 Chrome 页面上核对丢回执。Codemode 用的是放在后端资源目录里的官方 Node，不是 PATH 上的 node。这不是任意第三方插件或任意脚本运行时。
   需要 TCC、真实 SSH 或真实供应商的功能取得对应证据，不能用模拟结果代替。stdio MCP 在 `tools/list_changed` 后重新读取目录；读取失败保留上一份成功目录，并拒绝新的调用。HTTP/OAuth、媒体与更多服务兼容性仍独立验收。
3. **本机安装与交付。** 当前源码的一份 onedir 在 `.artifacts/native/package-rot666v1/AmazMe Python 0.1.0`。冻结 `build_id` 是 `fbd65a7173b7463f63e75e63bdc5506195aeb600a8be9d247d93c0a68506f07e`。启动身份与清单一致，页面模式是 installed。同一份包在 `PATH=/usr/bin:/bin:/usr/sbin:/sbin` 下启动；可执行文件、profile 和工作区路径都含空格。错的 `x-amazme-build` 得到 `stale_client_binding`，正确构建创建了会话。签名是本机 ad-hoc，不是可分发 DMG。更新实验最多再留一份。`package-rot666v1` 已在拒绝公网出站的 seatbelt 里完成首次 init 和 serve。含这次修复的包是 `package-mnk7cmvu`。它在更新准备好、监督器退出后，新脚本得到 `update_prepared`。两份包都在，下一次打包会让出更旧的那份。`package-mnk7cmvu` 的 Mach-O 已用 Developer ID 和 hardened runtime 重签，签名后清单 `build_id` 是 `40b5c6059646f8141ecbd80ba2ee1687543993cfb2f34e62d5186d97878afb10`。Gatekeeper 仍拒绝，原因是 `Unnotarized Developer ID`。公证和 staple 还没有做。只读查询公证历史时，`appstoreconnect.apple.com` 的证书签给了 `iadsdk.apple.com`，请求没有发出。没有提交归档，也没有关闭证书校验。不是可分发 DMG。
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

按改动选择 `verify_native.py`、`verify_client.py`、`verify_terminal.py`、`verify_mcp.py`、`verify_mcp_model.py`、`verify_electron.py`、`verify_tui.py`、`verify_cli.py`、`verify_rpc.py`、`verify_sdk.py`、`verify_screen.py`；
真实模型才运行 `verify_web.py --provider-config /private/provider.json` 或 `verify_mcp_model.py`。
模型 MCP 验证只读取 zsh 的 `DEEPSEEK_API_KEY`，写入权限 0600 的临时配置，结束后删除该文件并清空隔离 profile 的密钥。
不得输出密钥、复制全部环境到工具或把凭据放进仓库。MCP 探针依赖 `uv sync --project backend --frozen` 的开发依赖。
运行器有数量上限，已有两份证据时先核对和收敛旧产物，不绕过限制再构建。

提交前重读完整调用链，修复范围内缺陷，运行相关回归和实际链路，核对 schema、证据及文档一致。
显式 `git add <本会话路径>`，检查暂存 diff，再提交完整单元；不跳过钩子、不夹带其他会话修改。
提交后核对 hash、文件列表和剩余工作区，阶段末再次运行资源普查。只宣称本次证据覆盖的范围，不自动推送。

旧 28 个 am2 测试目录完整证据已压缩到 `.artifacts/history/20261024-p2-temp-evidence.tar.gz`（约 10.3 MiB），
摘要清单同目录保存。历史文档里的 `/tmp/am2-*` 路径已回收，需要时先检查归档，不重建 VM 或展开全部旧测试目录。
