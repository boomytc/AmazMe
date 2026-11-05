# 开发约定

当前产品由 Python 后端与 TypeScript 客户端组成，行为移植依据来自 Pi。产品形态只有 Web/桌面客户端；终端只保留启动与后台管理命令，程序化调用通过 HTTP/WS 和 Python SDK。模块职责见 `backend/ARCHITECTURE.md`，客户端依赖见 `docs/python-backend-ts-deps.md`。产品名、包作用域和命令是 AmazMe。依赖只向下。

## 对话

- 回答短、直接，用中文。
- 提交说明、issue、PR 评论和代码里不用表情符号，也不用客套话。
- 用户提问时先回答，再改代码或跑实现命令。

## 代码

- 不要用 `any`，除非确实没有别的写法。
- 相对导入带 `.ts` 扩展名，并遵守 `verbatimModuleSyntax`。类型用 `import type`。
- 外部行为和参照设计以读到的源码为准。
- TypeScript 包名是 `@amazme/*`，业务执行与持久化由 Python 后端拥有。
- OAuth 沿用 Pi 源码中的客户端 ID、回调配置和供应商请求身份，不随 AmazMe 产品重命名改写。
- 界面只针对桌面端适配：窗口和浏览器视口按宽窗布局，不为手机、触屏、软键盘或安全区另做版式，也不加粗指针热区和触屏专用文案。桌面壳的最小窗口宽度与这个范围一致。

## 资源

连续运行、生命周期跑分，以及阶段结束、上下文压缩、进程退出、Goal 暂停或准备写「清理完成」之前，运行：

```bash
backend/.venv/bin/python backend/tools/resource_census.py
```

阈值、归类和退出码以 `backend/tools/resource_census.py` 为准。空闲磁盘低于 50 GiB 预警，退出码 2。低于 20 GiB，或仍有临时 profile 上的 serve / supervisor / worker / execute / service-runner、无主 pty-gate / mcp-gate、Lima / hostagent、带本机产物路径的无头浏览器、VM 目录、`am2-` 临时目录、超过两份的 `package-*`，退出码 1。临时 profile 含 `/tmp`、`/private/tmp`、`.artifacts`、`am2-`、`.amazme-vm`，以及 macOS 用户临时目录 `/var/folders/<两级>/T` 和 `/private/var` 下的同一路径；目录已经不在也按启动参数里的路径归类。`/var/folders` 的 `C` 缓存和用户主目录里的常驻服务只记为 observed，不当作泄漏，也不按进程名停止。

`reclaimed` 只对应该次输出的 `scope`。测试 passed、某次 cleanup 字符串、或只匹配 `amazme_backend serve` 的 pgrep，都不是资源已经收回。

普查命令只报告，不删除目录。运行器达到自己的目录上限时，先去掉最旧且没有进程引用的那一份，不提高上限。VM 目录要先确认 owner；不要为了清理去安装或启动虚拟机。

台账在 `.artifacts/resource-ledger.jsonl`。

## 命令

采用 `confident-development-conventions`：先从代码结构保证逻辑闭环，再按改动影响完成一次有限验收，通过真实使用反馈迭代。同一份改动通过必要验收后，后续提交或交付复用结果。

改完一个包后，构建该包；类型检查按影响选择：

```bash
npm run build --workspace <name>
npm run typecheck
```

`npm run check:workspace` 覆盖版本号、临时目录、依赖方向、构建入口和测试资产残留。推送前使用当前改动的检查结果；有新改动或失败时再重跑受影响部分。

不要主动跑根目录完整 `npm run build`。`npm install` 用 `--ignore-scripts`。

## 运行验证

构建和类型检查不能证明已有数据在下一次启动仍可用。按变更实际影响，选择受影响的真实入口、保存后重开或边界输入做最小验收，使用独立 profile，不复制或改写用户数据。未覆盖的真实入口、旧状态或平台要在交付时说明。
源码桌面验收要求源码和产物指纹均与构建记录一致；运行 `npm run dev:desktop -- --build-only` 可只构建所需依赖，不启动应用。

异步或持久化改动沿相关路径核对状态归属、取消或失败出口、退出和再次进入；验收范围只覆盖本次疑点。

临时脚本、样本及验证输出放在系统临时目录或 `.artifacts` 等已有忽略目录，完成或中断后清理本轮资产。模型评测、连接测试、自检、诊断与产物完整性检查按实际用途保留；只读清单校验不代表真实运行通过。

## 启动与交付

- 当前阶段只通过 `./start.sh` 启动桌面，`./start.sh web` 启动 Web；`./start.sh --prepare` 准备本机依赖。
- 保留运行必需的 TypeScript、页面和 helper 编译，以及类型、依赖和资源检查。启动脚本按源码与产物指纹自动编译所需 workspace。
- 不生成独立应用、DMG 或冻结 Python 后端，不复制或签名 Electron 应用缓存，不执行公证、标签、GitHub Release 或安装包更新。仓库不维护这些流程。
- 版本仍记录在 `package.json` 和 `CHANGELOG.md`。不新增 `.github/workflows`。

## 分支

- 只维护 `main`。日常提交直接进 `main`，不再保留 `dev`。
- 阶段性闭环后推送到 `origin/main`；推送前按「命令」一节在本地把关（仓库没有 CI）。

## Git

- 只有用户要求时才提交。
- 只提交本会话改过的文件。用明确路径 `git add <path>`，不要 `git add -A` 或 `git add .`。
- 说明格式：`{feat,fix,docs}[(包名)]: <说明>`。说明用中文，写为什么。
- 不要运行 `git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git add -A`、`git add .`、`git commit --no-verify`。不要 force push。
