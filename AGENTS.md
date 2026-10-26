# 开发约定

当前产品由 Python 后端与 TypeScript 客户端组成，行为移植依据来自 Pi。模块职责见 `backend/ARCHITECTURE.md`，客户端依赖见 `docs/python-backend-ts-deps.md`。产品名、包作用域和命令是 AmazMe。依赖只向下。

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

持续打包、生命周期跑分，以及阶段结束、上下文压缩、进程退出、Goal 暂停或准备写「清理完成」之前，运行：

```bash
backend/.venv/bin/python backend/tools/resource_census.py
```

阈值、归类和退出码以 `backend/tools/resource_census.py` 为准。空闲磁盘低于 50 GiB 预警，退出码 2。低于 20 GiB，或仍有临时 profile 上的 serve / supervisor / worker / execute / service-runner、无主 pty-gate / mcp-gate、Lima / hostagent、带本机产物路径的无头浏览器、VM 目录、`am2-` 临时目录、超过两份的 `package-*`，退出码 1。临时 profile 含 `/tmp`、`/private/tmp`、`.artifacts`、`am2-`、`.amazme-vm`，以及 macOS 用户临时目录 `/var/folders/<两级>/T` 和 `/private/var` 下的同一路径；目录已经不在也按启动参数里的路径归类。`/var/folders` 的 `C` 缓存和用户主目录里的常驻服务只记为 observed，不当作泄漏，也不按进程名停止。

`reclaimed` 只对应该次输出的 `scope`。测试 passed、某次 cleanup 字符串、或只匹配 `amazme_backend serve` 的 pgrep，都不是资源已经收回。

普查命令只报告，不删除目录。打包可以在锁内去掉产物根下没有进程引用、超出保留份数的旧 `package-*`。运行器达到自己的目录上限时，先去掉最旧且没有进程引用的那一份，不提高上限。VM 目录要先确认 owner；不要为了清理去安装或启动虚拟机。

台账在 `.artifacts/resource-ledger.jsonl`。

## 命令

改完一个包后，先构建再跑这个包的测试：

```bash
npm run build --workspace <name>
npm test --workspace <name>
```

推送前跑 `npm run check:workspace`，它覆盖版本号、临时目录、依赖方向等仓库规则；改了 `scripts/` 再跑 `npm run test:engineering`。

不要主动跑完整 `npm test` 或 `npm run build`。`npm install` 用 `--ignore-scripts`。

## 发布

- 标签和 GitHub Release 一起处理。没有明确要求发布时，两者都不做。
- 1.0.0 之前不打 `v*` 标签，也不创建 GitHub Release。版本记在 `package.json` 和 `CHANGELOG.md`。本地验证和本地构建即可。`dist-release` 只保留正在构建的那一个版本。
- 1.0.0 之前只做本机自用构建。不提交公证，不查询公证历史，也不为了 Gatekeeper 反复重试。公证留到明确要求发布 1.0.0 时。
- `npm run release` 在版本低于 1.0.0 时直接拒绝。到 1.0.0 且明确要求发布时，才用它同时打标签、签名、公证并上传 GitHub Release。不单独打标签。
- 不新增 `.github/workflows`。发版检查和构建都在本机完成。
- 对外分发的 DMG 必须用 Developer ID 签名并公证：否则 Gatekeeper 拒绝打开，应用内更新也靠签名团队和 staple 确认更新来自同一发布者。不要为了省事削弱签名、公证或更新校验。
- 签名和公证凭证只留在本机：钥匙串、`.p8` 和 `~/.config/amazme/release.env`。不写进仓库，不放回 GitHub secret。
- 1.0.0 的发布步骤和公证排错见 `packages/gui/README.md` 的「DMG 与 GitHub Release」。
- 不手工打 `v*` 标签或建 Release。低于 1.0.0 时 `scripts/notarize-macos.mjs` 在读取凭据或访问公证服务之前拒绝。1.0.0 且明确要求发布之后，公证失败再用只读的 `--history-only` 或 `notarytool log <id>` 定位，不要为了试错反复发布。

## 分支

- 日常开发提交到 `dev`，不直接改 `main`。
- 阶段性闭环后再合入 `main`。仓库没有 CI，合入和推送前按「命令」一节在本地把关。
- 合入用 merge commit 或快进，不用 squash，保持两条分支历史一致。
- 直接在 `main` 上的热修要合回 `dev`。
- 版本标签只在 1.0.0 的发布里从 `main` 打，并与 GitHub Release 同时产生。

## Git

- 只有用户要求时才提交。
- 只提交本会话改过的文件。用明确路径 `git add <path>`，不要 `git add -A` 或 `git add .`。
- 说明格式：`{feat,fix,docs}[(包名)]: <说明>`。说明用中文，写为什么。
- 不要运行 `git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git add -A`、`git add .`、`git commit --no-verify`。不要 force push。
