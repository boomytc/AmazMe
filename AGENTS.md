# 开发约定

这个仓库的实现来自 Pi 的 packages。产品名、包作用域和命令是 AmazMe。依赖只向下。

## 对话

- 回答短、直接，用中文。
- 提交说明、issue、PR 评论和代码里不用表情符号，也不用客套话。
- 用户提问时先回答，再改代码或跑实现命令。

## 代码

- 不要用 `any`，除非确实没有别的写法。
- 相对导入带 `.ts` 扩展名，并遵守 `verbatimModuleSyntax`。类型用 `import type`。
- 外部行为和参照设计以读到的源码为准。
- 包名是 `@amazme/*`。`@amazme/agent` 对应原来的 `pi-agent-core`。

## 命令

改完一个包后，先构建再跑这个包的测试：

```bash
npm run build --workspace <name>
npm test --workspace <name>
```

不要主动跑完整 `npm test` 或 `npm run build`。`npm install` 用 `--ignore-scripts`。

## Git

- 只有用户要求时才提交。
- 只提交本会话改过的文件。用明确路径 `git add <path>`，不要 `git add -A` 或 `git add .`。
- 说明格式：`{feat,fix,docs}[(包名)]: <说明>`。说明用中文，写为什么。
- 不要运行 `git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git add -A`、`git add .`、`git commit --no-verify`。不要 force push。
