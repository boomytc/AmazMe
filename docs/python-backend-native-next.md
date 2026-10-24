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
| 出站正文不带供应商密钥 | 包含本文件的提交 | `backend/tests/test_automations.py`、`test_workflows.py`、`test_web_tools.py`：新的定时正文和工作流检查拒绝保存；已到期的密钥正文不投递；网页查询和地址不发送且不占调用；原话含密钥时不附带 |

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
监督器拒绝缺失会话行的源码 build_id 为 `f72091af61e53d0319c34ce6beeae58a24eaf79ab185fec746e22bd23281fc89`。宿主库已有会话表而没有这一行时，shell 和空工作区终端不会写入主目录。库文件或会话表还不存在时，监督器单测仍把目录当作 primary。
写明工作区仍核对会话行的源码 build_id 为 `bda5082f9311adea67b4087c2e4830b1b749fb9bf63cb1744980458aca513f00`。写明 primary 的终端和 MCP 在会话行缺失时拒绝。会话存在时，写明的名称仍指向那个授予目录。
分支沿用会话开关的源码 build_id 为 `fe0dad4d3b59706cc091aa04c7e3809fa56714808de7411d1fe78909988b2078`。子会话得到父会话的网页和桌面开关。已发出的网页调用和被挡住的桌面状态留在父会话。地址带账号时不分出新会话。没有真实付费调用，也没有读 macOS TCC。
取消授予后不定时提交的源码 build_id 为 `5a984e25943bb553fa121ded4ed6365cb4f57bd91a6155741f95d3b9cfe4925e`。授予取消后到期任务记为未知，不写入投递。不能再新建。记录里的工作区与会话当前目录不一致时也不提交。原目录里的文件仍保留。这不是页面里的另一次验收。
取消授予后不打开工作流的源码 build_id 为 `ddea02f76b2701c9385029d0d6b16a464760db8644f005706eaa132ec589815f`。未打开过的会话不会建库。已有工作流可重读、重放原结论、通过或取消。新的修正子任务不写入。主目录上的工作流仍可打开。这不是页面里的另一次验收。
记忆不送出供应商密钥的源码 build_id 为 `333eabf850c4450a97dd1309b32cba6a5a25128d7e122646c9a56d32e3cd6ad3`。含当前密钥的新记忆不会落盘，错误文本不含密钥。已经落盘的这类记忆仍留在库里，模型输入里没有它。不含密钥的记忆仍注入。更换密钥后，只含旧密钥的记忆不在这次检查里。
出站正文不带供应商密钥的源码 build_id 为 `5273ae98116ebd3250f7b0999d86365039da211b716edfa1b33de17871282ac1`。新的定时正文和工作流检查含当前密钥时拒绝，错误文本不含密钥。已经到期的这类定时任务记为未知且不再投递。网页查询或地址含当前密钥时不发送，也不占用调用。原话含当前密钥时不附带原话。已经排队的工作流检查仍会进入模型。这不是真实付费调用。

资源普查命令只报告。用户主目录里的常驻服务保持 observed。打包和运行器只删除自己目录中没有进程引用的超限产物；VM 目录和 `am2-*` 临时目录未确认前不删，也不为此安装或启动虚拟机。
下次再跑已有两份记录的运行器时，会让出该前缀最旧且无人使用的一份：`run-y5ei8l8q`、`terminal-atacoq7o`、`mcp-xi0hnry9`、`client-160ayfgl`、`electron-l7nfl4tr`、`tui-16drl4_s`、`cli-0wllgxmx`。台账引用的较新目录仍留下。终端画面已释放 `terminal-err1kda9`。Electron 这次已释放失败的 `electron-vntpwy9j`。`tui-m55jjevc` 是 TUI 证据，下一次 TUI 运行会先让出更早的 `tui-16drl4_s`。`cli-xc19exkk` 是 CLI 证据，下一次 CLI 运行会先让出更早的 `cli-0wllgxmx`。`rpc-ng488hhe` 是 RPC 证据。`sdk-wfo8x_to` 是 SDK 证据。`screen-27sf22xi` 是这次默认交互画面证据。

## 剩余执行顺序

1. **其余客户端实验。** Web 终端画面、Electron 源码进程、`amazme-backend tui`、print/JSON CLI、RPC、Python SDK 和默认交互画面已按各自范围验收。这些客户端都还没有覆盖输入丢回执、更新冻结，以及 worker 或监督器被杀掉的实验。TUI、CLI、RPC、SDK 和默认交互画面不是完整终端模拟。
   这些实验仍要按同一契约补证。先追踪已有实现，不另建一套业务运行时。
2. **按真实需求补齐产品功能。** 多工作区已在本机目录上核对：会话 shell、终端和没有 grant/ 前缀的文件工具进入授予目录，文件区显示当前浏览目录，侧栏显示当前会话的本机目录，取消授予不删文件。页面新建终端和连接 MCP 不跟随文件区。没有对应会话时，这些启动不会落到主工作区。宿主库已有会话表而缺少这一行时，监督器不改用主目录；写明工作区名称也会先核对会话行。会话存在时，显式 grant/名称 仍指向那个目录。
   `amazme-backend client decide` 已核对显式批准和拒绝。`client submit` 仍只等待终态。
   供应商密钥可以更换和清除。OAuth 仍未做。导入会先核对每个会话的工作区，以及反馈指向的会话。缺任何一项时不写入。分支在工作区已取消时拒绝，复制失败不留下项目关联。分支会复制网页和桌面开关，不复制已发出的调用或桌面运行状态。授予取消后，到期的定时任务记为未知且不再提交，也不能再新建。也不能再打开新的工作流或追加修正子任务。记忆正文含当前供应商密钥时不会保存，也不会放进模型上下文。定时任务、工作流检查和网页查询同样不会把当前密钥发出去。
   真实 SSH、插件、Codemode、computer-use、记忆、工作流、定时任务、网页工具及分享仍要逐项区分。
   需要 TCC、真实 SSH 或真实供应商的功能取得对应证据，不能用模拟结果代替。MCP 动态目录刷新、HTTP/OAuth、媒体与更多服务兼容性独立验收。
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
