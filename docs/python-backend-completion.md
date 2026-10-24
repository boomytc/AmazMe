# 本机优先重构验收台账

2026-10-24：执行架构已改为本机优先，现行契约见 [方案](python-backend-plan.md)。
以下旧报告只能证明对应历史构建，不能证明新的本机执行链。本轮从 f445fb49 开始实现；
当前源码与脱敏 [本机证据](python-backend-native-evidence.json) 同次提交。

| 当前阶段 | 状态 | 验收要求 |
| --- | --- | --- |
| A 文档和执行契约 | 已通过 | 文档、生成 schema 与代码契约一致，删除 VM 执行和构建链 |
| B shell/文件/审批/检查点 | 已通过此阶段范围 | 无 VM 的 Chrome/DeepSeek/本机工具闭环，取消、重试、真实进程崩溃恢复、检查点冲突与恢复 |
| C1 会话 PTY | 已通过此单元范围 | 本机终端、resize、输入去重、刷新重连、worker/监督器真实崩溃和明确关闭 |
| C1 终端画面 | 已通过此单元范围 | 归还输出窗口、256 KiB 滚动记录、页面解释转义、键盘与原输入账本；Chrome 观察到命令输出和 resize |
| C2 本机 MCP 服务与手动调用 | 已通过此单元范围 | 官方 SDK 本机进程 + Chrome；目录、JSON 参数、审批、去重、结构化结果、取消和真实崩溃恢复 |
| C2 模型驱动 MCP | 已通过此单元范围 | 真实 DeepSeek 选择本机探针工具，拒绝无副作用，结果回到模型；unknown 不重发，取消不关闭服务 |
| Electron 源码进程 | 已通过此单元范围 | 真实 Electron 装载当前源码后端；终端、shell 审批、检查点、MCP、双窗口关闭和显式退出 |
| TUI | 已通过此单元范围 | 真实 `amazme-backend tui` 进程：显式审批、文件、检查点、终端、MCP、离开不关闭、再次进入后显式关闭。进程内未确认的 `/pty` 输入沿用同一次编号 |
| CLI print/JSON | 已通过此单元范围 | 包入口 print/JSON 进程：显式审批、文件、检查点、终端、MCP、离开不关闭、再次进入后显式关闭。失败重试沿用代理目录里的输入编号 |
| RPC | 已通过此单元范围 | `--mode rpc` 进程：显式审批、文件、检查点、终端、MCP、松开绑定不关闭、显式关闭 |
| Python SDK | 已通过此单元范围 | 独立进程里的 `sdk.Client`：显式审批、文件、检查点、终端、MCP、进程退出不关闭、显式关闭 |
| 默认交互画面 | 已通过此单元范围 | 包入口交互进程：显式审批、文件、检查点、终端、MCP、离开不关闭、再次进入后显式关闭。进程内未确认的 `/pty` 沿用同一次编号 |
| C3 客户端未重复实验 | 未验收 | 各客户端没有重跑更新冻结，也没有重跑杀掉 worker 或监督器；完整终端模拟仍未做。监督器冻结后新的 shell、终端、MCP 和终端输入不开始。Electron 页面丢回执后沿用同一输入编号。CLI 失败重试沿用代理目录里的编号。RPC 和 SDK 由调用方传入编号。TUI 和默认交互画面只在当前进程内沿用未确认输入 |
| D 剩余功能与签名安装 | 待本机链路验收 | 供应商、OAuth、TCC、SSH、完整产品/签名分发与旧依赖清理 |

本轮三份运行报告的 build_id 均为 `c3f544e9061ff51f12d8fde261ad9018b4dda363f78b298643585f0d6e7af6ce`：

- `.artifacts/native/run-pba_z2fe/report.json`：审批前无副作用、过期审批拒绝、同 ID 不重复执行；自动检查点、预览、摘要冲突、选择恢复；取消与已知进程清理分开确认。
- `.artifacts/native/client-3gm1zrmd/report.json`：真实 Chrome 7 项通过，包含丢回执重试、A-B-A 迟到响应、断线重连和文件/检查点完整 UI 链，页面无错误。
- `.artifacts/native/browser-0mtoiofq/report.json`：Chrome 155 + DeepSeek Flash，审批刷新后仍有效，批准后真实本机 shell 写入并回读。凭据从 zsh 环境读取，临时源配置删除，隔离 profile 已清空模型密钥。

后端全套 426 项通过，另新增的真实 worker 崩溃、worker+监督器崩溃两项通过。
Ruff、Pyright、wheel/sdist、CLI 所需包构建和工作区规则检查通过。
34 个仅适用于 VM 的测试函数退役，34 个通用生命周期函数保留，增加本机启动/放行/结果/清理故障窗口与真实进程测试；不沿用旧 VM 矩阵的完成数字。
本轮未构建安装目录；验证产物高水位约 9 MiB，未启动或恢复 VM，所有验证所属服务均已退出。
包构建增加数量、占用、空闲磁盘和超时守卫；仅清理自己创建的构建中间目录。

边界：退出只针对登记和观察到的进程，不保证任意脱离后代停止。未知调用不重放，冲突按会话拒绝。
原始 shell 不提供自动检查点或副作用回滚。B 单元提交为 `b6c2d7a26e1dd769960313ab22bd30af47836751`。
本轮没有本机安装包、公证 DMG、真实 TCC/SSH/OAuth、物理磁盘耗尽、睡眠/断电证据，不能据此宣布全部重构完成。

### C1 本机终端证据

详见 [PTY 脱敏证据](python-backend-native-terminal-evidence.json)。真实 Chrome 验证显式新建、刷新后恢复同一终端、
输入丢回执重试只产生一次文件副作用、`stty` 观察 resize、关页面后继续运行、显式关闭后核对退出。
实际杀掉 worker 时终端继续运行；实际杀掉监督器时已知进程回收，同一终端 ID 保持失联且不重新执行。
全部 438 项测试通过；最后的并行清理修复新增回归后，相关 110 项通过。Ruff、Pyright、wheel/sdist 和工作区规则通过。
执行库丢失仍关闭拥有的进程句柄；单个终端停止未确认不妨碍关闭其他终端；旧 Host 和跨会话关闭被拒绝。
输入记录先于发送，排入终端不等于命令成功；Web 保留 32 KiB 尾部输出。完整终端模拟和其他客户端不在本单元完成声明中。
C1 提交为 `de851ab7e5ec4af47c147ba2455abcca941394d2`。MCP 的后续本机接入见下，不恢复 VM。

### C2 本机 MCP 服务与手动调用证据

详见 [MCP 脱敏证据](python-backend-native-mcp-evidence.json) 和 [阶段交接](python-backend-native-next.md)。
最终运行报告 `.artifacts/native/mcp-zrivjkax/report.json`，源码 build_id
`10bfc410a56b2b5026aa151310afd5a06eeece762131a38398bf33cd1d7692a3`。
Chrome 155 驱动真实本机官方 Python MCP SDK 1.26.0 探针服务：拒绝不产生副作用；审批刷新保留；
批准回执丢失后查询原结果；同一决定只有一次文件副作用；结构化结果保留。
停止运行中的调用后，受管进程清理确认但调用保持 unknown；同一服务 ID 不重启。页面无错误。
真实 worker 崩溃不停止会话服务；真实监督器崩溃核对已知资源并保留未知调用，不重复启动或发送。
当时全套 456 项通过，包含工作区里尚未提交的资源检查测试；Ruff、Pyright、wheel/sdist 和工作区规则通过。
那 456 项反映的是 C2 提交时的共同工作区，资源普查不在该提交内。
本单元只验收手动 MCP 调用。模型驱动见下一节。动态目录通知、HTTP/OAuth、媒体呈现及任意第三方服务兼容性尚未验收。

### C2 模型驱动 MCP

详见 [模型 MCP 证据](python-backend-native-mcp-model-evidence.json)。
源码 build_id `a84da7c3b4b8ea555cc12a4a096a2fd306fe76ae46797e70606e16d1fd1e364b`。
`verify_mcp_model.py` 使用隔离 profile 和 zsh 中的 `DEEPSEEK_API_KEY`：模型选择已连接的官方探针 `native_echo`，
会话审批拒绝时没有文件副作用；批准后探针只写入一次，工具结果进入后续模型回复。临时源配置已删除，profile 密钥已清空。
未决调用上限 512，身份上限 4096，终态查询窗口 100，不删除已有调用身份。取消一次调用不关闭服务。
本单元最终源码上后端测试 475 项通过；Ruff、Pyright 和工作区规则通过。没有构建冻结安装包，没有启动或恢复 VM。
动态目录刷新、HTTP/OAuth、媒体呈现和任意第三方服务仍未验收。终端画面见下一节；其余客户端仍未验收。

### C1 终端画面

详见 [终端画面证据](python-backend-native-terminal-screen-evidence.json)。
源码 build_id `f64fe5ec94e95dbaff3e431011bdd9a0454c854daa90c62ba9cb13aa6f506537`。
协议窗口仍是 32 KiB；监督器按已经读到的字节归还信用，所以长输出不会停在第一扇窗口。
重连保存最多 256 KiB 解码文本和 `output_seq`。`output_seq` 按 UTF-16 码元计数，和页面字符串长度一致。当时的页面自己解释回车、换行、退格、制表和 CSI 光标/清屏。当前页面打开 `@xterm/xterm` 5.5.0 的 DOM 画面；那次 Chrome 记录仍是更换之前的画面。键盘输入仍走原来的编号，鼠标没有交给 PTY。
直接按键与行表单使用不同的待确认 ID，走同一条输入账本；未知结果不重放。关页面不关闭终端。
`verify_terminal.py` 的报告是 `.artifacts/native/terminal-3i__hs0x/report.json`。Chrome 155 看到 `NATIVE_TERM_OK`、工作区路径和 `stty size` 的 `40 100`；丢回执后同一输入只写入一次文件；关页面后阶段仍是 running，显式关闭后 clean 且 exited。页面无错误。
这次运行释放了无人使用的 `terminal-err1kda9`。预算高水位 23,683,072 字节，空闲约 267.6 GiB，所属进程和全局普查都已收回。
本单元最终源码上后端测试 477 项通过，包含既有的 worker 与监督器终端崩溃测试；Ruff 和 Pyright 通过。没有构建冻结安装包，没有启动或恢复 VM。
这次 Chrome 运行不重复杀进程实验。画面不是完整 VT：没有备用屏幕、滚动区、鼠标、宽字符宽度和颜色。`output_seq` 按 UTF-16 码元计数，和页面字符串长度一致。保留文本被截短后，差值大于文本长度时会整段重放当前尾部。Electron 源码进程见下一节。TUI、CLI、RPC、SDK 尚未按这个画面验收。

### Electron 源码进程

详见 [Electron 证据](python-backend-native-electron-evidence.json)。
`verify_electron.py` 让桌面启动器执行当前检出的 `python -m amazme_backend`，没有使用冻结包。
这次源码 build_id 是 `23ad63ddfefd0ee93b8b9529cc1167609a2aac3763ea8b62a0097324ec467a51`。运行器没有改 `backend/src`。
报告 `.artifacts/native/electron-vv1fjgl1/report.json`。真实 Electron 页面打开 xterm 画面，红色 `RED` 画成 `xterm-fg-1`；完成终端输出、`stty` 观察到的 resize、刷新后终端仍在、显式关闭后退出；shell 审批后才写入文件；打开该文件并保存检查点；MCP 拒绝没有副作用，一次批准写入一次。第一次终端输入已经写到服务器，页面没有拿到回执；再次提交沿用同一输入编号，`electron-lost.txt` 仍是一个 `x`。这次运行释放了 `electron-wiplc67v`。
第二个窗口是另一个会话。关闭任一窗口后，源码后端、另一会话、推迟的请求和 MCP 服务都还在。显式退出 Electron 后，它所启动的后端退出，无关的 sleep 进程仍在。页面无错误。
预算高水位 37,617,664 字节，耗时约 7.8 秒，空闲约 266.8 GiB，所属进程和全局普查都已收回。没有启动或恢复 VM。
这次没有在 Electron 里重做更新冻结，或杀掉 worker 与监督器。旧的 `python-backend-electron-*.json` 只证明当时的冻结包。两份槽位已满时，运行器释放了更早的 `electron-o04d4rq_`。

### TUI

详见 [TUI 证据](python-backend-native-tui-evidence.json)。
`amazme-backend tui` 直接连接当前源码后端。源码 build_id `936905f85b7af4fc2e260250bd813cff78546d25b18cf396419e116f04ae9738`。
报告 `.artifacts/native/tui-m55jjevc/report.json`。真实进程在 faux 会话上拒绝 shell 没有写入文件，批准后文件内容是 `y`；读出该文件并保存检查点。终端输出出现 `TUI_TERM_OK`，输入已接收和命令结果分开显示，`stty size` 观察到 `40 100`。MCP 拒绝没有副作用，一次批准写入一次。
另一个 TUI 是另一个会话，离开它不停止第一个会话的终端和 MCP。Ctrl-C 只松开绑定，推迟的请求、终端和 MCP 都还在。再次带上同一会话后，显式关闭才让终端和 MCP 以 clean 退出。无关的 sleep 进程仍在。
预算高水位 41,308,160 字节，耗时约 7.4 秒，空闲约 266.8 GiB，所属进程和全局普查都已收回。没有构建冻结安装包，没有启动或恢复 VM。
这次没有在 TUI 里重做输入丢回执、更新冻结，或杀掉 worker 与监督器。画面只保留最近的可见行，不是完整 VT，也不是网页那套转义解释。默认 `amazme` 交互、CLI、RPC 和 SDK 不在这次验收里。

### CLI

详见 [CLI 证据](python-backend-native-cli-evidence.json)。
包入口是 `packages/coding-agent/dist/bundle/cli.js`，连接当前源码后端。源码 build_id 仍是 `936905f85b7af4fc2e260250bd813cff78546d25b18cf396419e116f04ae9738`，因为这次没有改 `backend/src`。
报告 `.artifacts/native/cli-xc19exkk/report.json`。真实进程在 faux 会话上，提示词里的命令不会自己批准。不是「批准」或「拒绝」的决定在联系宿主前被拒绝；同时指定请求和 MCP 调用也被拒绝。没有决定时 shell 停在等待审批，文件不存在；随后用同一请求拒绝，结果是 `approval_denied`，仍然没有文件。同一次运行带上「批准」后，文件内容是 `y`。同一会话读出该文件并保存检查点。
终端输出出现 `CLI_TERM_OK`，状态是 `accepted`，输入已接收和命令成功分开。`stty size` 观察到 `40 100`。MCP 没有决定时停在等待审批，拒绝没有副作用，一次批准写入一次。
另一个 CLI 是另一个会话，离开它不停止第一个会话的终端和 MCP。进程退出只松开绑定，推迟的请求、终端和 MCP 都还在。再次带上同一会话后，显式关闭才让终端和 MCP 以 clean 退出。无关的 sleep 进程仍在。
预算高水位 44,834,816 字节，耗时约 8.0 秒，空闲约 266.8 GiB，所属进程和全局普查都已收回。没有构建冻结安装包，没有启动或恢复 VM。
这次没有在 CLI 里重做更新冻结，或杀掉 worker 与监督器。失败重试会沿用写在代理目录里的输入编号；成功或 `/pty-ack` 之后，同一命令是新操作。输出只保留最近的可见行，不是完整 VT，也不是网页那套转义解释。RPC 和 SDK 使用调用方传入的输入编号。默认交互画面不在这次 CLI 验收里。

### RPC

详见 [RPC 证据](python-backend-native-rpc-evidence.json)。
`--mode rpc` 把每一行 JSON-RPC 转到当前源码后端。源码 build_id `763a4e6d956f9653e92a299f0f4a50b83526510c0ce74a3dec9d5222cbfc45c4`。
报告 `.artifacts/native/rpc-ng488hhe/report.json`。真实进程在 faux 会话上提交 shell 后停在等待审批。不带决定布尔，或摘要对不上，都不会执行；拒绝后结果是 `approval_denied`，文件不存在。带上明确批准后，文件内容是 `y`。同一绑定读出该文件并保存检查点。
终端写入的 `input_status` 是 `accepted`，输出里出现 `RPC_TERM_OK`，`stty size` 观察到 `40 100`。MCP 在明确决定前保持等待，错误摘要被拒绝，一次批准写入一次。
另一个 RPC 会话看不到这条终端。松开绑定不取消推迟的请求，也不停止终端和 MCP。显式关闭后两者以 clean 退出。无关的 sleep 进程仍在。
预算高水位 45,445,120 字节，耗时约 11.9 秒，空闲约 266.9 GiB，所属进程和全局普查都已收回。没有构建冻结安装包，没有启动或恢复 VM。
这次没有在 RPC 里重做输入丢回执、更新冻结，或杀掉 worker 与监督器。RPC 转发终端输出，不是完整 VT。默认交互画面和 SDK 不在这次验收里。提交文本本身不是审批。

### SDK

详见 [SDK 证据](python-backend-native-sdk-evidence.json)。
每个操作都是独立的 Python 进程，只通过 `amazme_backend.sdk.Client` 访问宿主。源码 build_id 仍是 `763a4e6d956f9653e92a299f0f4a50b83526510c0ce74a3dec9d5222cbfc45c4`，因为这次没有改 `backend/src`。
报告 `.artifacts/native/sdk-wfo8x_to/report.json`。真实进程在 faux 会话上提交 shell 后退出，审批仍在等待，文件不存在。缺少决定布尔值，或摘要对不上，都不会执行。拒绝后结果是 `approval_denied`。带上明确批准后，文件内容是 `y`。同一客户端读出该文件并保存检查点。错工作区在提交前被拒绝。
终端写入的 `input_status` 是 `accepted`，输出里出现 `SDK_TERM_OK`，`stty size` 观察到 `40 100`。MCP 错误摘要被拒绝，一次批准写入一次。
另一个 SDK 会话看不到这条终端。进程退出和松开绑定都不取消推迟的请求，也不停止终端和 MCP。显式关闭后两者以 clean 退出。无关的 sleep 进程仍在。
预算高水位 46,448,640 字节，耗时约 16.4 秒，空闲约 266.8 GiB，所属进程和全局普查都已收回。没有构建冻结安装包，没有启动或恢复 VM。
这次没有在 SDK 里重做输入丢回执、更新冻结，或杀掉 worker 与监督器。SDK 读取终端输出，不是完整 VT。默认交互画面不在这次验收里。这次没有给 `client submit` 增加决定。

### 默认交互画面

详见 [交互画面证据](python-backend-native-screen-evidence.json)。
默认 `amazme` 交互画面是包入口进程，不是 `amazme-backend tui`。源码 build_id 仍是 `763a4e6d956f9653e92a299f0f4a50b83526510c0ce74a3dec9d5222cbfc45c4`，因为这次没有改 `backend/src`。
报告 `.artifacts/native/screen-27sf22xi/report.json`。没有待审批时，单独输入「批准」只是一句提示，回答是 `已收到：批准`，文件不存在。shell 停在等待审批时，其他文字不会执行；拒绝后结果是 `approval_denied`。下一次明确批准后，文件内容是 `y`。同一画面读出该文件并保存检查点。
终端输出里出现 `SCREEN_TERM_OK` 和 `输入已接收`，`stty size` 观察到 `40 100`。MCP 拒绝没有副作用，一次批准写入一次。
另一个交互会话看不到这条终端。Ctrl-C 松开绑定，不取消推迟的请求，也不停止终端和 MCP。再次进入同一会话后，显式关闭使两者以 clean 退出。无关的 sleep 进程仍在。
预算高水位 49,483,776 字节，耗时约 7.4 秒，空闲约 266.7 GiB，所属进程和全局普查都已收回。没有构建冻结安装包，没有启动或恢复 VM。
进程内未确认的 `/pty` 沿用同一次编号，改内容不会发送；`/pty-ack` 核对后不再重放。离开这个进程后本地编号不保留。`packages/coding-agent/test/python-screen-terminal.test.ts` 用假客户端核对画面状态，并用真实 serve 核对同一编号只写入一次。这不是另一次包入口画面验收，也不是更新冻结、杀掉 worker 或完整终端。画面保留最近的可见行，不是完整 VT。

### 命令行决定

`amazme-backend client submit` 仍只等待终态。`client decide` 必须给出整词「批准」或「拒绝」，并且只能指向一个请求或一次 MCP 调用。
缺少决定、两个目标同时给出，或决定词不对时，命令在连接前退出。错工作区在执行前拒绝。
`backend/tests/test_client.py` 在真实 serve 上核对：提交 `/shell` 不会自己批准，文件不出现；拒绝后回执是 `approval_denied`。
下一次明确批准后，文件内容是 `y`。同一请求再次决定只返回已有回执，不会再写；对已拒绝的请求改口批准也不会执行。提交文本「批准」的回答是 `已收到：批准`。
本机探针的 `native_echo` 被拒绝时不写 `mcp-effect.txt`；批准后只追加一次。再次查询返回原结果。决定进程退出前松开自己的绑定，不关闭服务；显式关闭后服务以 clean 退出。
这次使用 faux 和仓库内探针，不是任意第三方 MCP 兼容性，也没有重做输入丢回执、更新冻结或杀掉 worker 与监督器。源码 build_id 为 `67fc998cc3f5ef502f4ea6b41bf1549363f82224805fdd4ff2cc47bf3996c8b0`。没有构建冻结安装包，没有启动或恢复 VM。

### 资源收尾

28 个已核实归属的旧 `/private/tmp/am2-*` 测试目录已压缩归档，逐文件摘要核对后删除原目录；
归档 `.artifacts/history/20261024-p2-temp-evidence.tar.gz` 为 10,834,356 字节，清单为同目录的
`20261024-p2-temp-evidence.manifest.json`。下文历史报告的 `/tmp/am2-*` 原路径应从此归档查找。
最终 MCP 验证后资源普查退出码 0，范围内无后端/浏览器残留、VM 目录、am2 临时目录或 package 目录；
数据卷空闲约 267.78 GiB，`.artifacts` 约 22 MiB。本轮没有构建冻结安装包或创建 VM。
这些结论仅覆盖普查列出的 scope，不能扩展为整台机器无任何资源占用。

资源普查随后单独收口：命令只报告，退出码 0/2/1 分别是可继续、磁盘预警、拒绝新增。
用户主目录中的常驻服务记为 observed，不按进程名停止。临时 profile 上的 serve、supervisor、worker、execute、service-runner，无主的 pty-gate / mcp-gate，以及带产物路径的无头浏览器记为泄漏。macOS `/var/folders/<两级>/T` 与 `/private/var` 别名同样是临时 profile，profile 目录已经不在也按参数归类；`C` 缓存目录不是泄漏。交互画面测试先走 `stop` 并等待所属 Host、监督器和仍带该 profile 的后代退出，再删除目录。
打包在锁内只删除产物根下没有进程引用、超出保留窗口的旧 `package-*`。运行器达到两份时只删除最旧且没有进程引用的一份，不提高上限。
VM 目录和 `am2-*` 临时目录只报告；未确认不删除，也不安装或启动虚拟机。
源码身份未改。隔离 profile 实跑时 build_id 仍是 `10bfc410a56b2b5026aa151310afd5a06eeece762131a38398bf33cd1d7692a3`；
启动期间 serve 与 supervisor 被记为泄漏，关闭后所属进程为空，owned 与 global reclaimed 均为 true。
该 profile 高水位 905216 字节，空闲最低约 267.77 GiB，预算未触发。结束后普查退出码 0，`.artifacts` 仍约 22 MiB。
资源检查测试 18 项通过。这次没有重跑全套后端测试。下一次已满两份的运行会让出 `run-y5ei8l8q`、`terminal-err1kda9`、`mcp-xi0hnry9` 和 `client-160ayfgl`。

## 历史功能和 VM 证据（不作为当前完成声明）

以下内容保留历史来源，所有「下一步」和 VM 验收要求均已失效；只执行当前方案及上方阶段交接。

# Python 后端重构验收台账

日期：2026-10-24。分支 `dev`。本文件按用户能完成的操作记录状态，并随实现更新。四类状态分开，不能互相冒充：

1. **P2 代码和协议**：持久化、生命周期、故障注入和 faux 客户端。已跑过的才算通过。
2. **P2 环境**：真实文件系统空间耗尽、宿主睡眠/唤醒、物理断电。模拟不能算通过。
3. **P3 产品与客户端**：方案第 2、6、7 节里尚未由 Python 内核闭环的能力。
4. **P4 交付**：完整安装资源、签名公证、平台实测、性能和旧 TS 业务依赖清理。

P2 的代码和协议门槛通过后，可以继续没有被环境挡住的 P3。环境项和公证未完成时，整个重构仍未完成。改定义不能把未跑项标成通过。

## 当前证据

| 项 | 值 |
| --- | --- |
| 矩阵与浏览器所依据的源码 | `d5cefaf0faa02505fe8e8696a5b7fd01df723f49` |
| 会话分支所依据的源码 | `0b73c8262a17982893326e07ca9a4ad15bb2e7de` |
| 安装 A | `.artifacts/python-backend-p2/package-gbn32ffr/AmazMe Python 0.1.0` |
| A build_id | `257b71973f69ed8fe2178ab41acddbb973360e44db507dc7c7ba7a1af6ddac5c` |
| 安装 B | `.artifacts/python-backend-p2/package-r3e13r24/AmazMe Python 0.1.0` |
| B build_id | `7f4e9d802bbe1be8a96748bfdd89bf677bf09811e44398a12b6c8bbbd143b2fb` |
| 矩阵报告 | `/tmp/am2-uphi4eyo/report.json`（本地，不进 Git） |
| 浏览器报告 | `.artifacts/python-backend-p2/client-xzj9q131/report.json` |
| 这两份安装包 | 本机 ad-hoc onedir，不是已签名公证的 DMG |

`d5cefaf` 之后的源码改动不在 A/B 里。那些安装包不能为新能力背书。修复前的 wheel/sdist 也不再当作当前源码的构建证据；当前源码需重新 `uv build`。

`6c2b25c` 又打了两份 onedir。A 是 `.artifacts/python-backend-verify-a/package-h9p3ay_o/AmazMe Python 0.1.0`，build_id `ab5e3c4cbd48a3ccd24a3596545f5226a5d7b4abbdbfd94af8073d38b9a88ff0`。B 是 `.artifacts/python-backend-verify-b/package-9h7swttg/AmazMe Python 0.1.0`，build_id `0f1ffd0f603c3dbb3c7f1be4333bf943bb575700f64933beb849c3ecdb85661f`。`verify_p2.py --case all` 34 项都是 passed，没有 failed、not_run 或 skipped。报告是 `/tmp/am2-lvmsk__7/report.json`。强停虚拟机走包内 `runtime/lima`，不是 `resources/lima`。这不包含宿主睡眠、物理断电、Linux 宿主、OAuth 或 TCC。同一份源码上 ruff 通过，pyright 0 错误，pytest 390 项通过。

## 1. P2 代码和协议

协议是 `amazme-http/1`。存储格式是 2。产品版本是 0.1.0。`build_id` 单独标识一次构建。

| 用户操作 | 入口 | 状态 | 自动测试 / 运行 | 证据 | 未通过与下一步 |
| --- | --- | --- | --- | --- | --- |
| 创建会话、排队、引导、忙时拒绝、取消 | `POST /api/v1/sessions`，`/submissions`，`/cancel`；Web 提交方式 | 已通过 | `backend/tests/test_session_p2.py`；矩阵里的取消与审批用例 | A/B，34 项矩阵 | 无 |
| 继续会话、重连、预览与持久结果一致 | `GET /snapshot`，`WS /api/v1/events` | 已通过 | `backend/tests/test_streams_p2.py`；`verify_client.py` 6 项 | Chrome 155，报告见上 | 新 Web 功能还没有进这次浏览器报告 |
| 后台子工作、定时唤醒、审批 | worker `/submissions`，`/approvals` | 已通过 | `test_session_p2.py`；`children.*`，`scheduled.worker_crash`，`approval.auto`，`approval.wait` | 矩阵 | 无 |
| 相同 ID 重试不重复副作用；内容冲突拒绝 | 提交与效果核对 | 已通过 | `test_storage.py`，`test_session_p2.py` | 单测 + 矩阵 | 无 |
| 未知调用不盲目重放 | `POST /effects/resolve` | 已通过 | `test_execution_p2.py`；矩阵核对步骤 | 矩阵 | 无 |
| 业务终态晚于清理证明；旧 epoch 未清理不授权新执行 | 监督器清理回执 | 已通过 | `children.cancel_descendants`，`cleanup.unavailable` | 矩阵 | 无 |
| spawn 前登记；停止证明不足保持 blocked | 监督器 | 已通过 | `supervisor.*` 八点：`create_intent`，`created`，`registered`，`started`，`before_permit`，`permitted`，`result`，`closed` | 矩阵。`supervisor.*` 同时杀掉 worker 和监督器 | 无 |
| worker 各提交窗口崩溃后不重复外部效果 | worker | 已通过 | `worker.model_intent`，`model_result`，`tool_intent`，`tool_result`，`decision`，`cleanup` | 矩阵 | 无 |
| 只读快照在重启预算耗尽时返回该事实且不创建 worker | `GET /snapshot` | 已通过 | `test_lifecycle.py::test_exhausted_session_budget_is_reported_without_spawning`；`workers.restart_budget` | 源码 `host.py` reader；矩阵 | 无 |
| 监督器关闭不持控制锁等待仍要该锁的 worker | `POST /control/shutdown` | 已通过 | `test_execution_p2.py::test_shutdown_releases_control_before_waiting_for_a_worker`；矩阵 `approval.wait` 的停止 | 源码 `supervisor.py` shutdown | 无 |
| 旧 Host 的迟到停止不能跨代 | 接管 | 已通过 | `host.takeover_stale_stop`，`host.lost_delivery` | 矩阵 | 无 |
| stopping/unknown 参与者不被新实例覆盖后遗漏 | 更新名册 | 已通过 | `update.roster`；`test_lifecycle.py` 名册测试 | 矩阵 | 无 |
| 同版本不同 build_id 的冻结、验证、激活 | `POST /control/updates/*` | 已通过 | `update.freeze`，`prepared`，`health`，`complete_crash`，`roster` | A 与 B | 验证 worker 不跑模型和业务工具，由冻结探针覆盖 |
| 重启不自动解除未完成更新 | Host 启动 | 已通过 | `test_lifecycle.py` 更新屏障重启用例 | 单测 | 无 |
| 慢客户端不阻塞持久提交 | WebSocket | 已通过 | `test_streams_p2.py`；`host.pause_delivery`；`events.ack_resync` | 矩阵 | 无 |
| 被替换的安装文件拒绝 ready | 启动 | 已通过 | `bundle.replaced_file` | 只改克隆 | 无 |
| 存储提交窗口崩溃 | worker | 已通过 | `storage.commit_crash` | 矩阵。SQLite FULL 另有单测，不等于磁盘写满 | 无 |
| Linux shell、读文件、写文件 | faux/真实模型工具，监督器执行 | 部分通过 | P1 `verify_runtime.py` / `verify_web.py`；P2 矩阵里的 shell 后代 | A/B 的 faux 路径 | 符号链接、硬链接、并发写和多工作区未做 |
| 从已完成的根任务分支，上下文此后隔离 | `POST /api/v1/sessions/{id}/branches`；会话里的「从此处分支」 | 部分通过 | `backend/tests/test_session_branch.py` | `0b73c8262a17982893326e07ca9a4ad15bb2e7de` 的单测和 happy-dom。不在 A/B 包内 | 还没用打包后的真实 Chrome 点这次分支。父会话历史在子会话继续后保持不变，由该测试覆盖。工作区已取消时不分出新会话。复制失败时不留下项目关联，父会话和原文保留。子会话沿用网页和桌面开关，已发出的调用和被挡住的桌面状态留在父会话。地址带账号时不分出新会话 |

矩阵命令：

```bash
backend/.venv/bin/python backend/tools/verify_p2.py \
  --executable "$P2_A" --target-executable "$P2_B" --case all
```

34 项全部 `passed`，没有 `failed`、`not_run`、`skipped`。共享 profile 和审批 profile 的停止、删 VM、进程租约退出通过。`vm.force_stop` 只证明 VM 强停，不证明宿主断电。

`9b83b083` 又打了两份包并重跑同一条 `--case all`。摘要是 `docs/python-backend-head-p2.json`。A 是 `.artifacts/python-backend-head/package-yboxdh3i`，build_id `f3b24e92d590c7343c3d04a76b48e2dffe6d0e2142edb45980e74d56805c0cd8`。B 是 `package-4qxl9x82`，build_id `a9667286a889153a1d55d77d6e39c529d867a60d8d4b7a89868fc2b7e30be331`。34 项都是 `passed`，清理是 `passed`。同一份 A 上的 Chrome headless `verify_client.py` 6 项通过，页面错误为空，报告是 `.artifacts/python-backend-p2/client-jwdc18bu/report.json`，浏览器 155.0.8059.85。这两份仍是本机 ad-hoc onedir，不是公证 DMG。早先 `d5cefaf` 的 A/B 记录仍然有效，不拿这次覆盖那次的 build_id。

## 2. P2 环境

| 用户操作 | 入口 | 状态 | 运行 | 证据 | 未通过与下一步 |
| --- | --- | --- | --- | --- | --- |
| 隔离卷真实写满时，已接纳请求还在，失败的那次没有落下 | `backend/tools/verify_enospc.py --output <报告>` | 已通过，只证明 2MiB HFS+ 镜像上的文件系统 ENOSPC | 当前源码跑过。失败码 `storage_failure`，消息是 `database or disk is full`，写满后可用块为 0，`max_page_count` 仍为 4294967294 | 本地报告不进 Git。已接纳的 `kept` 还在，失败的那次请求不在 | 不证明 SQLite 页数上限、VM 强停、睡眠或断电。睡眠仍用 `capture_wake.py`，现在是未验收 |
| SQLite 页数上限触发 FULL | 单测把 `max_page_count` 收到当前页数 | 已通过，范围仅限页数上限 | `test_storage.py::test_sqlite_full_rolls_back_receipt_and_batch_and_latches` | 单测 | 不能写成磁盘写满 |
| 宿主睡眠后唤醒，已接纳数据仍在 | `backend/tools/capture_wake.py` | 未验收 | `--prepare` 只写场景 | `test_environment_evidence.py` 确认 prepare 不会标通过 | 用户自行睡眠并唤醒后，`--record` 再打开原 profile 核对。脚本不会让机器睡眠 |
| 物理断电 | 无安全入口 | 未验收 | 不跑 | 无 | 不关机、不断电。取不到就保持未验收 |

## 3. P3 产品与客户端

参考协议名不等于该认证已经可用。下面未列出的供应商、OAuth、图片和分类都还没实现。占位错误不算完成。

| 用户操作 | 阶段 | 入口 | 状态 | 测试 / 运行 | 未通过与下一步 |
| --- | --- | --- | --- | --- | --- |
| 文本、工具流、终止与 faux usage | P1/P2 | `providers.stream`，faux 与 DeepSeek Flash | 部分通过 | faux 单测；P1 有一次真实 DeepSeek | 推理签名和缓存费用在 `f3bd837`。其余供应商价格未做。真实供应商只用已经授权的凭据 |
| 模型目录、选择、自定义端点、代理和请求头 | P3 | `GET/POST /api/v1/models`；侧栏模型表单 | 部分通过 | `backend/tests/test_model_catalog.py` | `0e9053cd`。目录是 faux 与 DeepSeek。DeepSeek 可改 https 端点。代理密码不进回执和会话记录。请求头有数量和名称限制。OAuth 未做 |
| API key | P1 | `POST /api/v1/models/credential`；侧栏「更换密钥 / 清除密钥」 | 部分通过 | `backend/tests/test_model_catalog.py` | 更换和清除带期望代际。同时写入只有一个成功，过期代际和更新冻结不会覆盖已保存的密钥。模型选择请求不能携带密钥，校验错误也不回显提交内容。尚未发出的模型调用在发送前重读磁盘上的密钥；密钥已清除则不创建供应商连接。响应不含密钥。OAuth 刷新仍未做，也没有用真实供应商再发一次 |
| OAuth、单一刷新管理者、取消期间 token 落盘 | P3 | 无 | 未通过 | 无 | 按供应商要求的 client ID、回调和请求身份实现。缺账号时保持未验收并继续无关功能 |
| 图片、分类 | P3 | `POST /api/v1/sessions/{id}/submissions` 的 `images`；页面「图片」；SDK `submit(images=)` | 部分通过 | `backend/tests/test_images.py` 落盘后用本地供应商流核对请求体，并用 happy-dom 发送所选文件 | 一次最多 8 张，每张不超过 8 MB，只接受 PNG、JPEG、WebP、GIF。图片字节存在用户消息上，下一次请求放进 `image_url`。回执只计张数。用量、快照和消息事件不含图片正文。错误的 base64 不会落盘。分类仍未做，也没有把图片交给真实视觉模型 |
| 会话产物 | P3 | `POST/GET /api/v1/sessions/{id}/artifacts`；页面「产物」；SDK `put_artifact` | 部分通过 | `backend/tests/test_artifacts.py` 保存后从磁盘读回，并用 happy-dom 打开列表和正文 | 每个会话最多 32 个，每个不超过 1 MB。同一 ID 相同内容再次保存不另写一份；内容或名称不同则保留原文。符号链接被拒绝。名称不能是路径。正文里的供应商密钥不会落盘，错误文本也不含密钥。这不是工作区文件，也还不会把过长命令输出自动收进产物 |
| 会话库同一时刻只有一个写入者 | P3 | 会话 worker 持有 `session.lock`；宿主读取走只读连接；写入在锁被占用时转到该 worker 的 `/session-ops` | 部分通过 | `backend/tests/test_session_lock.py` | 第二份打开得到 `session_locked`，关闭后才能再写。只读连接在锁被占用时仍能读到已提交的文本和网页策略。符号链接锁在建库前拒绝。格式不对不会留下锁文件。真实服务里 faux 回合之后，另一个进程打不开库，宿主仍能把策略写进持有者并读回。这不是 A/B 包里的验收 |
| 会话归档 | P3 | `POST /api/v1/sessions/{id}/archive`；页面「归档 / 恢复」 | 部分通过 | `test_session_branch.py` 的归档用例和 happy-dom | `1af60222`。不在 A/B 安装包里，也还没有真实 Chrome。历史不删除；未开始的任务变为已取消 |
| 上下文压缩、过期结果拒绝、压缩失败保留原历史 | P3 | `POST /api/v1/sessions/{id}/compactions`；页面「压缩上下文」 | 部分通过 | `test_session_branch.py` 的压缩用例和 happy-dom | `8c9cee19`。摘要走当前供应商。依据不一致拒绝写入。失败不删原消息。原文含当前供应商密钥时不请求摘要，错误文本不含密钥。返回的摘要含当前密钥时不写入。已经落盘且含当前密钥的摘要不会进入下一轮模型输入，用户本轮不同的原文仍会发送。同一次压缩先占编号；已经写好或仍未知时不再请求模型。页面沿用同一次。明确没有发出去的失败会放开占位。还不在 A/B 包和真实 Chrome 里 |
| 切换会话 | P2 Web | 侧栏 | 已通过 | `verify_client.py` 的 A-B-A | 分支后的切换有 happy-dom 测试，还没有进 Chrome 报告 |
| 文件浏览、编辑、diff、受检写入 | P3 | `GET /api/v1/files`、`GET/POST /api/v1/files/content`；页面「工作区文件」 | 部分通过 | `backend/tests/test_workspace_files.py`；`test_boundaries.py` 会执行客户机脚本 | `0ebbe95` 页面按摘要写入。`9e2defe` 的客户机 `read_file` / `write_file` 拒绝越界符号链接、符号链接目录和硬链接，工具写入必须先准备摘要，缺父目录不会创建。没有 grant/ 前缀的工具路径落在会话工作区；显式 grant/名称 仍指向该目录。多工作区映射见 `efbda5d`。这些提交都不在 A/B 安装包里 |
| 多工作区与统一路径映射 | P3 | `POST /api/v1/workspaces`；页面「工作区文件」 | 部分通过 | `backend/tests/test_workspaces.py` 授予目录、读写文件、工具命令和终端 cwd | 主工作区是 profile 里的本机目录。额外目录授予后，文件接口仍用逻辑路径 `grant/名称`，shell 和终端的实际目录是该本机绝对路径。会话里的 read_file 和 write_file 若没有 grant/ 前缀，读写的是该会话目录。显式 grant/名称 仍指向那个目录。页面文件区显示当前浏览目录的绝对路径。侧栏在选中会话后显示该会话工作区的本机目录，未选会话时写「本机工作区」。新建终端和连接 MCP 不跟随文件区，工作区留空后由宿主按会话目录打开。会话不存在时，这些启动和调用不会落到主工作区。宿主库已有会话表而缺少这一行时，监督器拒绝 shell、空工作区终端，以及写明了工作区名称的终端和 MCP，不改用主目录。会话存在时，写明的名称仍指向那个授予目录。库文件不存在、会话表不存在、库损坏或工作区为空时，新的 shell、终端和 MCP 不启动，也不写文件。已经打开的终端仍可读取和关闭。用户主目录、`.ssh`、钥匙串、profile 和 `docker.sock` 不能授予。取消授予不删目录里的文件，也不把会话改到主目录。授予取消后，到期的定时任务记为未知且不再提交。这不是虚拟机挂载，也不在安装包验收里。 |
| PTY、终端输入、resize、输出背压 | P3 | `POST /api/v1/sessions/{id}/terminals`；页面「终端」 | 部分通过 | `backend/tests/test_pty.py` 会执行客户机脚本，并经监督器打开同一条命令 | `6dcdc47`。输出超过窗口后不再转发，直到客户端授信。退出码只来自 waitpid，连接断开保持 unknown。容器规格无网络、不分配 Docker TTY。本机测试直接跑该 PID 1 脚本，没有在 Lima 里再跑一遍。Docker 桥接代码未对真实 daemon 验收 |
| 工作区持久依赖卷和固定工具镜像 | P1 资源 / P4 分发 | 构建期离线镜像 | 部分通过 | P1 运行记录 | 运行时不临时拉镜像。完整离线首启属 P4 |
| SSH / 远端 daemon | P3 | `POST /api/v1/sessions/{id}/remotes`；页面「远端」 | 部分通过 | `backend/tests/test_remote.py` 启动 `remote_daemon.py` 并经监督器连接 | `81b0186`。核对主机密钥、daemon 内容和代际。本地断开后阶段是 disconnected 或 blocked，不是已停止。未知调用不重放，代际不符时挡住新命令。页面在结果未知时沿用同一调用和命令，改命令不会另开一次。这不是一次真实 OpenSSH 到远端主机的会话 |
| MCP 连接、目录、审批、取消 | P3 | `POST /api/v1/sessions/{id}/mcp`；页面「MCP」 | 部分通过 | `backend/tests/test_mcp.py` 执行客户机脚本，并经监督器打开同一条命令 | `7719860`。stdio 服务在客户机里。目录来自 tools/list。调用先落成等待批准，批准后才转发，同一 ID 的不同参数冲突。停止后的退出码来自 waitpid，清理失败会挡住下一个 MCP。OAuth 未做。本机没有在 Lima 里再跑。MCP 不代替其他插件 |
| Codemode 受控 JS | P3 | `POST /api/v1/sessions/{id}/code`；页面「脚本」 | 部分通过 | `backend/tests/test_codemode.py` 运行 QuickJS helper、监督器提交/取消，以及页面脚本 | `6319c3f`。成功才提交状态。失败、超时、取消和没有退出证明都不提交。没有 waitpid 时，同一会话不能再开新脚本，同一 run id 不重放。已发生的工具副作用不回滚。helper 不再从 PATH 找 node。冻结包 `package-4vcvcbxo` 的 build_id 是 `8de2ce8c953f1de8d5129e9472707c2f9c5e4c77f1506436d7008569f4ffe122`，Node 在 `resources/node/bin/node`，QuickJS 在包内。现场脚本用的就是这个 Node，报告 `docs/python-backend-node-runtime.json`。脚本仍不进 Linux 客户机，也不暴露任意宿主文件和网络。Node 进程只拿到工具环境，不继承供应商密钥、控制令牌或 SSH agent。页面在结果未知时沿用同一次运行，改来源不会另开，取消打到这次运行。Chrome 页面 `verify_code_page.py` 的报告是 `.artifacts/native/code-page-uk2d9kmf/report.json`：脚本把状态 `n` 加一，回执被丢掉后再次提交，状态仍是 `n=1`。Node 放在后端资源目录里，不是 PATH 查找。 |
| 已批准的原生桌面动作 | P3 | 无 | 未通过 | 无 | 独立驱动，并证明退出和资源归属。不做任意 macOS shell |
| 插件身份、配置、入口、受管生命周期 | P3 | `POST /api/v1/plugins`、`GET /api/v1/plugins`；页面「插件」 | 部分通过 | `backend/tests/test_plugins.py` 运行固定入口，并经监督器登记、调用和重新加载 | `268556a`。打开插件面板会读取已保存的插件，`244820e`。入口只有 stamp，由监督器启动，许可里没有命令或 SQLite。同一调用不重复写入，内容冲突拒绝。没有退出证明时不能再调用。worker 还持有旧插件指纹时不能更换。定时等待等未结束任务会挡住登记和重新加载，原任务文本保留。这不是 MCP。入口还没放进 Linux 客户机，也不在 A/B 包里。插件门只拿到工具环境，不继承供应商密钥、控制令牌或 SSH agent。页面在结果未知时沿用同一次调用，改文本不会另开。Chrome 页面 `verify_plugin_page.py` 的报告是 `.artifacts/native/plugin-page-rc58cb4k/report.json`：登记后第一次调用已写入 `stamp.txt`，回执被丢掉，再次提交仍是一行 `mark-once`。这不是 Codemode，也不是任意第三方插件。 |
| 历史搜索 | P3 | `GET /api/v1/sessions/{id}/search`；页面「历史」 | 部分通过 | `test_session_branch.py` 的搜索用例和 happy-dom | `6fc70d5`。只查当前会话已落盘的任务文本和消息。`%` 按字面匹配。归档后仍可搜。不注入记忆，也不搜索其他会话。还不在 A/B 包和真实 Chrome 里 |
| 记忆发现与上下文注入 | P3 | `POST /api/v1/memories`；页面「记忆」 | 部分通过 | `backend/tests/test_memories.py` 保存记忆，并由 `Worker.perform` 注入模型输入 | `da0240c`。记忆按工作区保存。只有与用户原文相配、且属于该会话工作区的记忆会放进模型上下文。同一 ID 的不同内容冲突，原文保留。匹配是子串，不是语义检索。正文含当前供应商密钥时拒绝保存，错误文本不含密钥。已经落盘的这类记忆仍留在库里，但不会放进模型上下文。还不在 A/B 包里 |
| 文件检查点、预览和选择性恢复 | P3 | `POST /api/v1/checkpoints`；页面「保存检查点 / 预览 / 恢复」 | 部分通过 | `backend/tests/test_checkpoints.py` 写入前备份、预览不改文件、按摘要恢复 | `25fc14e`。受检写入前记下原内容。预览只给出差异。恢复只改这一条路径，且必须对上当前摘要；不符则磁盘内容不变。模型写入已有文件前会按会话工作区记下原内容；新文件没有检查点。还不在 A/B 包里 |
| 定时任务、时区与去重 | P3 | `POST /api/v1/automations`；页面「定时」 | 部分通过 | `backend/tests/test_automations.py` 拒绝夏令时缺口和含糊时刻，并检查调度只提交一次 | `189a130`。到期时刻来自 IANA 时区。2026-03-08 02:30 纽约时间被拒绝。2026-11-01 01:30 必须指定 fold，两次相差一小时。同一 ID 的不同内容冲突。到期后只在一次事务里写提交回执；会话已归档、授予已取消，或记录里的工作区与会话当前目录不一致时，记为未知且不再提交。授予取消后不能再新建定时任务，原目录里的文件仍保留。正文含当前供应商密钥时拒绝新建，错误文本不含密钥。已经到期的这类任务记为未知且不再投递，正文仍可由当前用户读到。这是一次性时刻，不是周期规则。还不在 A/B 包里 |
| 工作流：独立检查、有限修正、阶段恢复、子上下文、父子取消 | P3 | `POST /api/v1/sessions/{id}/workflows`；页面「工作流」 | 部分通过 | `backend/tests/test_workflows.py` 用 faux 跑子任务，并经页面提交所选会话 | `e9bb34e`。检查和修正各是独立子任务，不复制父会话消息。未通过时最多再开修正上限那么多次；同一结论重复提交不再开子任务，不同内容冲突。恢复只读已落盘的阶段。取消工作流会取消子任务；只取消子任务不会取消工作流，也不会补一个新的。归档会取消尚未结束的工作流。授予取消后不能再打开新的工作流，也不能追加修正子任务；已有工作流仍可重读、重放原结论、通过或取消。原目录里的文件仍保留。新的检查正文含当前供应商密钥时拒绝，错误文本不含密钥。已经排队且含当前密钥的检查不会进入模型，该子任务记为未知，检查正文仍可重读。用户本轮输入仍会发送。更换密钥后，只含旧密钥的检查不在这次检查里。这不是通用阶段图，也没有命令检查或阶段内并发。还不在 A/B 包里 |
| 网页搜索和抓取 | P3 | `POST /api/v1/sessions/{id}/web` 与 `/web/calls`；页面「网页」；模型工具 `web_search` / `web_fetch` | 部分通过 | `backend/tests/test_web_tools.py` 用本地假响应跑页面调用，并用 faux 回合驱动 `Worker.perform` | `4d30ac2` 是页面调用。`42db378` 让模型工具留在会话 worker，不打开客户机。打开面板读取已保存策略在 `97f8fe6`，再次保存不退回默认端点。默认关闭。只发送已保存的 DeepSeek API key，不转发聊天端点、代理、附加请求头，也不接受调用里的端点或密钥。策略关闭或没有 key 时不发请求，也不占用调用 ID。响应超过上限，或连接在请求发出后中断，记为未知并且同一个调用不再发送。明确的 HTTP 失败和重定向也不重发，且不跟随重定向。不读取环境变量里的 key。成功时工具结果写入会话，页面上的回答就是这份结果。没有真实付费调用。分支会复制网页开关，不复制已发出的调用。地址里带账号或密钥时不分出新会话。查询或抓取地址含当前供应商密钥时不发送，也不占用调用。原话含当前密钥时不附带原话。页面在结果未知时沿用同一次查询，改查询不会另开。还不在 A/B 包里 |
| 桌面观察、坐标、新鲜度和清理 | P3 | `POST /api/v1/sessions/{id}/computer`；页面「桌面」 | 部分通过 | `backend/tests/test_computer_use.py` 运行固定驱动脚本 | `fe73248`。默认关闭。驱动报告缺权限时不发点击，调用方不能自己声明已授权。方向 6、比例 2 的点 (1,4) 换成驱动像素 (8,16)；方向 1、比例 2 的点 (3,4) 换成 (6,8)。过期或被新观察替换的截图不会发出。第二个动作在前一个尚未回答时被拒绝。驱动在动作途中退出则保持未知，没有退出码就不会清理，清理后才能再观察。这不是 cua-driver，也没有读 macOS TCC 或操作真实桌面。未配置时驱动报告未授权。分支会复制桌面开关，不复制被挡住的运行状态。驱动进程只拿到工具环境，不继承供应商密钥、控制令牌或 SSH agent。页面在结果未知时沿用同一次点击，改画面或坐标不会另开。还不在 A/B 包里 |
| 项目、设置、反馈、分享、新格式导入导出 | P3 | `POST /api/v1/projects`、`/settings`、`/feedback`、`/sessions/{id}/shares`、`GET /sessions/{id}/shares/{id}`、`/export`、`/import`；页面「管理」 | 部分通过 | `backend/tests/test_management.py` 导出后再次导入，并拒绝旧格式和改过的摘要 | `b74e2d3`。打开管理面板会 GET 已保存的项目，`318ea95`。分享后会 GET 已保存的正文，`5de3d5c`。项目、显示名、反馈和分享在同一 ID 下内容冲突会保留原文。新建会话带上调用方编号时，同一编号和相同标题、工作区、项目返回原会话；编号相同但这些字段不同则拒绝。页面在结果未知时沿用这次项目和会话编号，成功之后下一次是新的操作。导出是 amazme-export/1，不附带供应商密钥、代理或请求头。导入不删除已有会话；摘要不符或旧格式被拒绝。写入前先核对每个会话的工作区和项目，以及反馈指向的会话。缺任何一项时不写入项目、会话、反馈或正文。会话里如果出现已保存的密钥，导出和分享会拒绝并且错误文本不含密钥。这不是公开链接，也不是文件 artifact 或用量账单。搜索和模型目录是分开的入口。还不在 A/B 包里 |
| 使用量、费用、诊断；日志不漏凭据 | P3 | `GET /api/v1/sessions/{id}/usage` 与 `/diagnostics`；页面「用量」「诊断」 | 部分通过 | `backend/tests/test_usage.py` 用 faux 跑完两轮后读取合计，并核对 deepseek-flash 的目录价格；`backend/tests/test_diagnostics.py` 读取失败码并挡住密钥 | 合计来自已经落盘的模型完成记录。可见回答的输出 token 等于回答字数。输入 token 不含缓存读和缓存写。faux 目录价格是 0。deepseek-flash 的输入、输出、缓存读和缓存写单价与 `packages/ai` 的目录一致，按每百万 token 的微美元向下取整。本地供应商流把 `prompt_tokens_details.cached_tokens` 计为缓存读，优先于 `prompt_cache_hit_tokens`。推理签名按供应商原文落在助手消息上，下一次请求原样放回 `reasoning_details`，用量响应只计个数。没有目录价格、或带缓存 token 却没有缓存单价的调用使 `priced` 为 false，并且不返回部分费用。诊断只给出状态和短错误码；自由文本换成 `unlisted`。其他供应商价格仍未做。凭据和签名正文不进用量响应。 |
| Web 完整产品 | P3 | `backend/src/amazme_backend/web` | 部分通过 | `verify_client.py` 6 项；分支按钮有 happy-dom | 地址必须同时写明 `host`（等于这份后端的 `profile_id`）、`session` 和 `workspace`，否则不连接，也不会选中列表第一项。`?new=1` 还要带宿主和工作区。点开会话或新建之后，地址会写上这三项。`backend/tests/test_window_page.py` 覆盖缺地址、错误宿主、点名会话和新建。Electron 打开 Python 窗口时带上 `host.pythonReady().profileId`。管理面和分支还没有在真实 Chrome 里再跑 |
| Electron 启动包内 Python、配对、退出、更新 | P3/P4 | `node packages/gui/dist/start.js`；`AMAZME_PYTHON_BACKEND` 或 `Resources/amazme-backend/amazme-backend` | 部分通过 | `packages/gui/test/python-desktop.live.test.ts` 用真实 Electron 入口把当前 onedir 拉起两次；`docs/python-backend-electron-launch.json` | `55b0173` 接上启动参数。`bef9f14` 把配对码写进该窗口的会话，并让关窗不调用退出。现场两次启动的 build_id 是 `5df74527eb72fdf034f4e3be2d9aef23a4393f8109d74506fbf3c8ed34b1f830`，宿主 pid 分别是 42463 和 42565。两次登录框都已隐藏。关窗后该 pid 仍在，明确退出后该 pid 消失，旁边的 sleep 进程还在。桌面更新在替换前用暂存包里的 build_id 冻结。源构建重启不激活。目标构建先验证再激活，现场在 `docs/python-backend-desktop-update.json`。没有 64 位目标 build 时不冻结。多窗口在 `6e0d96d`，报告是 `docs/python-backend-electron-windows.json`：包是 `package-fe7_msbu`，build_id `a44cf603121570ffcb1037fcb331ba3bb6b22d106555ddda367aa7157e41a73e`。真实入口拉起两次，每次两个窗口，工作区都是 primary，四个会话各不相同。关掉另一个窗口，再关掉持有等待任务的窗口，任务仍是 `waiting_time`，`cancel_requested` 为 false，宿主 pid 60666 和 61246 还在。明确退出后这两个 pid 消失，旁边的 sleep 还在。这不是已签名 DMG。还没有公证。`desktop-page` 的 smoke 退出码是 0，但监督器记录仍是 `running`：关闭响应先返回，桌面随后杀掉宿主，`close` 没来得及写 `stopped`。关闭接口现在会先停掉所持监督器并落盘 `stopped`，再返回。桌面等待这次请求的上限是 60 秒，用来盖住宿主最多 30 秒的退出证明。`.artifacts/python-backend-sign/desktop-quit/AmazMe-macos-arm64.dmg` 用的是 `package-js9ny5kl`，签名前 build_id `f0b925e79838d2e72f2abc95e50d3e2005e47d50acbed934f3715b53501b9277`，签名后 `4197b4241dd1de0d14b1c7517b941261cafc6e73df5627ef1eacc697580522b1`。已签名应用 smoke 退出码 0，`boot` 为 true，`serverId` 与 `profile_id` 都是 `eb6548038fe8e5f5bc5d84f4a5b448f4`，协议 `amazme-http/1`。监督器 `7202fd820abf96761d9d0f570dfd89dd` 的记录是 `stopped`，smoke 结束后没有留下这个 profile 的进程。公证 Accepted，提交 `7f350709-2b6a-45ec-8971-a9c7d7f46263`。staple、`spctl` 和 `codesign --verify --deep --strict` 退出码都是 0。钉住后的 SHA256 是 `2844f33971317cda73428cb52e0eec127796c919d6dee8e819e9b882b8a0cab7`。`desktop-page` 没有这次关闭修复。 |
| CLI 与非交互 | P3 | `amazme-backend client` 的 create、submit、release、cancel、rpc、decide。服务命令是 init、serve、worker、supervisor、stop、pair，另有 tui、pty-gate、mcp-gate。没有 destroy-vm | 部分通过 | `backend/tests/test_client.py`；`backend/tools/verify_frozen_clients.py` | `77101bd` 在源码入口上通过。`26ffe5e` 用冻结 onedir 再跑了同一组命令，build_id `6d4ba35edcfd8e8f7f00241883c168f70d87320eeff9a7f35ecd62b2164c7c47`，报告 `docs/python-backend-frozen-clients.json`。`submit` 的回答是 `已收到：你好`。松开绑定后旧绑定再写被拒绝。错工作区时 stderr 只有 `workspace_mismatch`。令牌不在输出里。这不是已签名 DMG，也没有覆盖文件或远端。`destroy-vm` 不是服务命令，拒绝后不创建 profile。桌面更新测试不再调用它。历史 `verify_p2.py`、`verify_relocated_bundle.py` 和 `measure_runtime.py` 仍写着这个命令，不要运行 |
| RPC | P3 | `POST /api/v1/rpc` | 部分通过 | 源码测试和 `verify_frozen_clients.py` 都打到这条路由 | `77101bd`。冻结包上的同一检查在 `26ffe5e`，build_id `6d4ba35edcfd8e8f7f00241883c168f70d87320eeff9a7f35ecd62b2164c7c47`。提交和取消要带工作区，不一致就拒绝并且不执行。`session.release` 只丢掉绑定。这不是已签名 DMG |
| 异步 SDK | P3 | `amazme_backend.sdk.Client`；冻结包里的 `client` 子命令走同一条实现 | 部分通过 | 同上 | `77101bd`。`26ffe5e` 里 SDK 对着冻结 serve 松开绑定，任务仍在等待，旧绑定再写得到 `stale_client_binding`。冻结 `client submit` 拿到 `已收到：你好`。这不是已签名 DMG |
| TUI | P3 | 默认 `amazme` 交互；`amazme-backend tui`；`--python-url` 与 `--python-token` 接到指定宿主 | 部分通过 | `backend/tests/test_tui.py`；`verify_frozen_clients.py`；`backend/tests/test_python_interactive.py`；`test/durable-main-startup.test.ts` | `ac0c7f1` 让默认交互不再打开旧 durable 界面。不带参数时从 PATH 的 `amazme-backend` 拉起或接上已有 Python 宿主，工作区是 primary，画面写出会话和绑定。Ctrl-C 后宿主还在，等待任务不取消，第二次输入得到 `已收到：你好`。已有 `config.json` 不会被清空。第一次 profile 用 faux。`--python-url` 和 `--python-token` 必须成对出现，用来连指定宿主。`AMAZME_DURABLE_TUI=1` 不在帮助里，也不再切换运行时。设了这个变量仍然走 Python。测试不再用 `legacy-durable-cli` 启动旧界面。产品 `--session` 拒绝旧会话，不打开旧会话库。默认的 `--print`、`--mode json` 和 `--mode rpc` 也走 Python：文本输出是 `已收到：你好`，JSON 带工作区和状态，RPC 转发到 `POST /api/v1/rpc`，松开绑定不取消等待任务。冻结 `tui` 又跑过一次，build_id 仍是 `6d4ba35edcfd8e8f7f00241883c168f70d87320eeff9a7f35ecd62b2164c7c47`，pid 是 32224 和 32263。这不是已签名 DMG。进程内未确认的 `/pty` 输入沿用同一次编号，改内容不会发送；`/pty-ack` 核对后不再重放。离开这个进程后本地编号不保留。这不是更新冻结、杀掉 worker 或完整终端。默认交互画面的未确认 `/pty` 也只在当前进程内沿用同一次编号 |
| 多窗口、多宿主、绑定代际 | P3 | Web 有 A-B-A 草稿测试；两个 `amazme-backend tui` 对同一个 serve | 部分通过 | `test_streams_p2.py` 的所有权测试；`verify_client.py`；`test_tui.py` 的两个终端 | `eae6735`。两个终端同时在线时，离开一个不会取消另一个会话里的等待任务，留下的那个仍能看到 faux 回答。Electron 两个窗口在 `6e0d96d`，现场记录是 `docs/python-backend-electron-windows.json`。远端多宿主还没有 |

## 4. P4 交付

| 用户操作 | 状态 | 入口 | 未通过与下一步 |
| --- | --- | --- | --- |
| 移动安装目录、路径含空格、受控 PATH、离线首次启动 | 部分通过 | `backend/tools/verify_relocated_bundle.py`；`docs/python-backend-head-install.json` | `9b83b083` 的包 `package-yboxdh3i` 被复制到带空格的目录后，在 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` 时启动两次。build_id 仍是 `f3b24e92d590c7343c3d04a76b48e2dffe6d0e2142edb45980e74d56805c0cd8`，协议 `amazme-http/1`。两次 ready 是 2.959 秒和 1.297 秒，套接字只有 `127.0.0.1`，pid 14288 和 14412 已退出。同一份 seatbelt 里，连 `1.1.1.1:443` 得到 Operation not permitted，连 `127.0.0.1:9` 得到 Connection refused，然后这个进程完成了首次 init 和 serve。这是进程出站被拒绝，不是拔掉机器网线。`b76ad5d` 那次 `allow default` 的 seatbelt 拦不住 https://example.com，那次离线结论作废。同一份源包又被复制到 `bundle xq7p0mae`，serve 使用的 seatbelt 在包外拒绝名为 python、python3、python3.*、node、colima、docker 的执行，包内同名文件仍允许。两次 init 和 serve 都完成，pid 42759 和 42871 已退出。`lsof` 看到的程序映像里没有这些系统命令，`forbidden_runtime` 为空。报告是 `docs/python-backend-head-runtime.json`。包内解释器是 `_internal/Python.framework`，不是 `/usr/bin/python3`。`package-4vcvcbxo` 的 build_id `8de2ce8c953f1de8d5129e9472707c2f9c5e4c77f1506436d7008569f4ffe122` 在 `docs/python-backend-node-runtime.json`。deny-default 会让 Virtualization.framework 发不出沙箱扩展，所以带工具的那次 seatbelt 改为允许默认，并拒绝 `/usr`、`/opt`、`/usr/local`、`/bin`、`/Library`、`/System`、`/Applications` 上的 python、node、colima 和 docker。Codemode 执行了包内 `resources/node/bin/node`。`/shell echo amazme-shell-ok` 的 stdout 就是这句，容器是 `11d7271227c9`，宿主侧看到的是包内 `limactl`。MCP 目录出现 echo，调用结果是 `amazme-mcp-ok`。三处 `forbidden_runtime` 都是空。进程树仍会拒绝包外的这些名字。这不是拔掉机器网线，也还不是公证过的 Python 安装包。 |
| 构建身份覆盖代码、依赖、插件、helper 和执行资源 | 部分通过 | `source_identity_files()` 含 `.mjs` 与插件门；`package_backend.py` 把 Node、helper、`plugin_gate.py` 和 `quickjs.wasm` 算进冻结 `build_id` | `package-4vcvcbxo` 的 build_id 是 `8de2ce8c953f1de8d5129e9472707c2f9c5e4c77f1506436d7008569f4ffe122`。缺任何一项就拒绝写清单。客户机镜像和 lima 仍由同一份文件表覆盖。 |
| 桌面私有更新衔接冻结、验证、激活 | 部分通过 | `9f2cd64` 的 `packages/gui/src/main.ts` `settlePythonUpdate`；`packages/gui/test/python-update.live.test.ts`；`docs/python-backend-desktop-update.json` | 源包 `package-fe7_msbu` build `a44cf603121570ffcb1037fcb331ba3bb6b22d106555ddda367aa7157e41a73e` 冻结后 `activated` 为 false。同一源构建再次启动仍不激活，提前 complete 是 `update_target_mismatch`。目标包 `package-syyayj_m` build `0169b95e3e5f724e096d7a7fae3b5cf47c517c44d9ee41b097664514db9df06b` 先得到 `validation` 用途的验证 worker，再激活。之后健康状态是 ready，提交回答是「已收到：更新后」。这不是已签名 DMG，也没有走公证后的安装器替换。 |
| Developer ID、hardened runtime、公证、staple、Gatekeeper | 部分通过 | `scripts/package-desktop.mjs` 与 `scripts/notarize-macos.mjs`。禁止 `npm run release`。记录在 `docs/python-backend-signing.json` | 当前登录钥匙串里有 1 个 Developer ID Application，且属于 `release.env` 里的团队。`6624dc52` 记下的「2 个身份都不匹配」不是这次读取的结果。只读 `notarytool history` 成功，没有提交归档。`package-yboxdh3i` 里的 `amazme-backend` 原件仍是 ad-hoc。它的一份副本用 Developer ID、hardened runtime 和时间戳签过，`codesign --verify --strict` 通过，团队与配置一致，但这份副本没有公证。现有桌面打包流程打出的 `.artifacts/python-backend-sign/desktop/AmazMe-macos-arm64.dmg` 用同一身份签名。公证 Accepted，提交 `cc84ac41-6d73-464d-a496-74914b94b9d9`。staple 校验通过，`spctl --assess --type open` 退出码 0。钉住之后的 SHA256 是 `e0bfad05a4e6ff619d9ce862fd07c57f1fb1190928545c3e88a1ebf24fea84fb`。这个 DMG 是 Electron 44.6.0 加官方 Node v22.23.3 的预览包，里面是 `@amazme/gui` 和 `@amazme/coding-agent`，不是 Python onedir。随后 `scripts/package-desktop.mjs --python-backend` 把冻结包打进 `Contents/Resources/amazme-backend`。为了让 codesign 不把资源目录当成 bundle Resources，冻结目录叫 `runtime`。这份桌面 DMG 是 `.artifacts/python-backend-sign/python-desktop/AmazMe-macos-arm64.dmg`，Python build_id `fad52a180bc053a906e0bfad00e30cb1d1b5f78a0fc4d5f88f3ce1e452a3d915`。公证 Accepted，提交 `c277e305-87e4-476c-a1dd-b8ee23b6b2f8`。staple、`spctl` 和 `codesign --verify --deep --strict` 退出码都是 0。钉住后的 SHA256 是 `c0366c5dbc2d42ab165d49d0dbeeeaa4e453fc6297deeb3db1cf2d2243ea7e76`。应用里仍有 `@amazme/coding-agent`。这是这次改打包脚本之前的产物，没有重新签名公证。当前 `scripts/package-desktop.mjs` 不再把 `@amazme/coding-agent` 放进桌面闭包。`16b6e5f6` 用这个脚本打出 `.artifacts/python-backend-sign/desktop-current/AmazMe-macos-arm64.dmg`。安装的包是 ai、chord、codemode、durable、gui、telemetry、web，没有 coding-agent。Python onedir 来自 `package-e4fbezy7`，build_id `fad52a180bc053a906e0bfad00e30cb1d1b5f78a0fc4d5f88f3ce1e452a3d915`，不是这次 HEAD 重新打包的后端。Developer ID、hardened runtime。那份 DMG 公证提交是 `9f05224d-b733-4284-b720-14644be20e87`，但签名改写了 `_internal/Python`，服务以 `build_resource_mismatch` 退出，不能当启动证据。随后在签完内层二进制、封外层应用之前重写冻结清单。新的 `.artifacts/python-backend-sign/desktop-boot/AmazMe-macos-arm64.dmg` 同样不含 coding-agent。签名后的 build_id 是 `a561427495a15b41f35449d5124d81623b8ed3312daf7f082aca6b652f30b477`。公证 Accepted，提交 `73a6e978-4364-415c-a319-0d0f6ddbda17`。staple、`spctl` 和 `codesign --verify --deep --strict` 退出码都是 0。钉住后的 SHA256 是 `232e851afe15c8879cc7a6c6acec5697fa6d3c9ee24c7f0b24ed5916a42c33f0`。已签名应用 smoke 退出码 0，就绪行协议是 `amazme-http/1`，地址写明了宿主和工作区。那次页面上的 `__AMAZME_BOOT__` 是空的。当前源码在 `GET /` 写入该宿主的版本、协议、profile 和事件地址，并用脚本正文的 sha256 放行这一段，不用 `unsafe-inline`。`desktop-boot` 还没有这份页面。随后从同一工作区打出 `.artifacts/python-backend-sign/desktop-page/AmazMe-macos-arm64.dmg`。onedir 是 `package-dlpmf83w`，签名前 build_id `23c67f69a122835bea740bd20029fe28b751bf9423918f59e109b4f87ce72ade`，签名后 `9f0cd59f1bd188016f2b17c609e6559a89ae0a443387d73a267a643962a6f914`。已签名应用 smoke 退出码 0：`boot` 为 true，标题 `AmazMe 0.1.0`，`mode` 是 installed，`serverId` 与就绪 `profile_id` 都是 `85280ea6ede093d413d2b126380ba757`，事件地址是 `ws://127.0.0.1:62967/api/v1/events`，协议 `amazme-http/1`，宿主 pid 20195。包内没有 coding-agent。公证 Accepted，提交 `80ff1888-7448-4eb3-82df-fd2ebb229359`。staple 校验、`spctl --assess --type open` 和 `codesign --verify --deep --strict` 退出码都是 0。钉住后的 SHA256 是 `1c7a75c05235072fe1f7a5b03423cc421f804b232eb2d58e0f597437ce6d2600`。当时的桌面包使用构建时的 gui 包版本。当前 `packages/gui/package.json` 已改为 0.1.0。没有打标签，没有 GitHub Release。 |
| Linux 宿主组合 | 未验收 | 无本机环境记录 | 没有环境就保持未验收 |
| 冷/热启动、RSS、提交延迟、事件规模、历史加载、取消到真实退出 | 部分通过 | `b64769e` 的 `backend/tools/measure_runtime.py`；`docs/python-backend-runtime-timing.json`；ready/RSS 另见 `docs/python-backend-relocated.json` | 包 `package-fe7_msbu`，build_id `a44cf603121570ffcb1037fcb331ba3bb6b22d106555ddda367aa7157e41a73e`。冷提交到回答可见 10.748 秒，POST 返回时状态仍是 queued。随后 8 次的 POST 是 0.0035 到 0.0055 秒，再过 0.026 到 0.029 秒能读到「已收到」。快照 0.0087 秒，9 个请求、70 个事件、28932 字节。搜索「历史条目」0.0069 秒，50 条命中、5965 字节。`/shell sleep 120` 处于 running 时取消，0.124 秒后回执是 cancelled 且 `cancel_requested` 为 true；再过 0.165 秒，取消前看到的客户机容器已不在 `docker ps`。宿主上没有单独的 sleep 进程。ready 两次是 4.104 秒和 1.364 秒，RSS 174144 KB 和 173840 KB，只含宿主和监督器。这不是最终安装产物上的曲线。 |
| 删除旧 TS 业务依赖 | 未通过 | `docs/python-backend-ts-deps.md` | Python `backend/src` 不导入 TypeScript。产品 `main.ts` 的交互、print、JSON 和 RPC 不再因 `AMAZME_DURABLE_TUI=1` 进入旧运行时。桌面 `boot` 缺少 Python 后端时直接失败，不再启动 `bundle/cli.js`。`scripts/package-desktop.mjs` 的闭包不再包含 `@amazme/coding-agent`。`amazme web`、`server`、`client`、`import` 和 `export` 已拒绝启动旧宿主或旧会话迁移。`host/commands.ts`、旧的 durable 交互、print、RPC、import、`runtime.ts` 和 `export.ts` 已删除。`createDurableSession` 直接拒绝，不再打开旧会话。旧 `/share` 默认不再导出旧会话。宿主服务目录和 `host/server.ts` 不再导入 `durable/sessions`、`durable/harness-setup`、`durable/fork-management`。设置辅助在 `core/hosted-settings.ts`，分叉准入在 `core/fork-admission.ts`，旧宿主仍用这套逻辑，没有改成 Python。`durable/harness-setup.ts` 已删除。`session-worker` 不再安装旧 MCP、子工作、Codemode、提示词、工具图片和洞察扩展；终端不再进入旧供应商菜单。Python 会话库用同目录 `session.lock` 独占写入。faux session worker 和真实测试宿主都不再调用 `openSessionStorage`。会话选中的模型记在 Python 的 `session_models`。配置了 `AMAZME_PYTHON_URL` 时，测试宿主的终端命令走 Python 终端接口，不再调用 `createPolicyEnv`。没有这个地址时，实验终端仍用 `createPolicyEnv`，因为本机没有 Lima 实例。分类没有用占位接口冒充。`packages/evals` 的运行入口在选择模型之前拒绝，不再调用 `createDurableSession`。删除整目录仍未通过。OAuth、睡眠、断电、Linux 宿主和 TCC 仍未验收。展开的 `python-desktop` 应用目录里不再有 `node_modules/@amazme/coding-agent`；那份 DMG 文件没有改写。桌面产品版本改为 0.1.0，`CHANGELOG.md` 在 0.3.x 记录之上追加了 0.1.0，没有改写旧记录。`desktop-page` 不含 coding-agent，页面也能读到这份宿主的 `__AMAZME_BOOT__`。呈现、TUI 组件和受控 JS helper 保留。OAuth、睡眠、断电、Linux 宿主和 TCC 仍未验收。 |

## 下一步

1. 工作区文件浏览和受检写入在 `0ebbe95`，客户机文件工具的链接约束在 `9e2defe`。后者的 Ruff、Pyright 和 pytest 312 通过。A/B 安装包仍是 `d5cefaf`。
2. 默认 `amazme` 的交互、`--print`、`--mode json` 和 `--mode rpc` 都走 Python 宿主。文本回答是 `已收到：你好`，JSON 带工作区和状态，RPC 转发到 Python，松开绑定不取消等待任务。`--python-url` 和 `--python-token` 成对使用时连到指定宿主。`AMAZME_DURABLE_TUI=1` 不再切换运行时。冻结 onedir `package-5xggd2k2` 的 build_id 是 `6d4ba35edcfd8e8f7f00241883c168f70d87320eeff9a7f35ecd62b2164c7c47`。`26ffe5e` 在这上面重跑了命令行、RPC、SDK 和终端，报告是 `docs/python-backend-frozen-clients.json`。Electron 多窗口在 `6e0d96d`，现场记录是 `docs/python-backend-electron-windows.json`，build_id `a44cf603121570ffcb1037fcb331ba3bb6b22d106555ddda367aa7157e41a73e`，宿主 pid 60666 和 61246。每个窗口的地址写明自己的会话和 primary 工作区。关掉窗口后等待任务仍是 waiting_time。两个终端同时在线的隔离在 `eae6735`。命令行、JSON-RPC 和异步 SDK 在 `77101bd`。真实 `python -m amazme_backend serve` 上，松开绑定不取消等待任务，错工作区被拒绝，命令行提交得到 faux 回答。还没有在冻结 onedir 里跑这组命令。桌面用真实 Electron 入口把包内 Python 拉起两次的记录在 `bef9f14`，build_id `5df74527eb72fdf034f4e3be2d9aef23a4393f8109d74506fbf3c8ed34b1f830`。那两次窗口不是公证包。项目列表读取在 `318ea95`，分享正文读取在 `5de3d5c`，项目、反馈、分享和导入导出在 `b74e2d3`。OAuth 仍没有消费者。模型网页工具在 `42db378`，打开面板读取策略在 `97f8fe6`，仍没有真实付费调用。桌面观察在 `fe73248`，用的是固定协议驱动，不是 cua-driver，也没有真实 TCC。网页搜索和抓取的页面调用在 `4d30ac2`。工作流在 `e9bb34e`。定时任务在 `189a130`。文件检查点在 `25fc14e`。工作区记忆注入在 `da0240c`。多工作区路径映射在 `efbda5d`。插件登记和受管入口在 `268556a`，打开面板读取已保存插件在 `244820e`。当前会话历史搜索在 `6fc70d5`。Codemode 在 `6319c3f`。远端 daemon 在 `81b0186`。MCP 在 `7719860`，终端 PTY 在 `6dcdc47`。这几项都还没有真实 Linux/OpenSSH 验收。OAuth 未做。插件入口、额外工作区和客户机文件检查点都还没在 Lima 里验收。工作流还不是通用阶段图。
3. 睡眠和断电保持未验收。ENOSPC 只证明 2MiB 隔离卷。`9b83b083` 的含空格路径、受控 PATH 和进程级离线首启在 `docs/python-backend-head-install.json`。那次证明的是 seatbelt 拒绝公网 TCP，不是机器断网。
4. 桌面预览 DMG 的 Developer ID、公证、staple 和 Gatekeeper 已在 `docs/python-backend-signing.json`。Python onedir 仍是 ad-hoc，正式安装产物还没有换成这份公证 DMG，DMG 里也还是旧 TS 宿主。没有运行 `npm run release`。Pyright 在 `20c145f` 之后是 0 错误。部分完成报告是 `docs/python-backend-partial-completion.md`。整个重构未完成。
