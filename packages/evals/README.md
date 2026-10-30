# AmazMe evals

评测通过 `backend/tools/run_eval.py` 启动现有 Python Host。Node 只负责 Vitest、用例计划、判分和报告；没有另一套会话运行时，也不构建容器。

先准备 Python 开发环境；真实模型必须显式选择，并通过 `AMAZME_EVAL_PROFILE` 指定现有 Python profile 的凭据库。源凭据库独占 OAuth refresh token，临时 profile 只借用 access token；每轮重新核对源凭据。评测结束停止自己持有的进程、清除借用凭据、检查退出证明，再删除自己创建的临时目录。不修改全局 HOME 或个人配置。

```bash
AMAZME_EVAL_PROFILE=/absolute/path/to/profile \
AMAZME_PROVIDER=openai-codex AMAZME_MODEL=gpt-5.6-sol \
npm run eval -w @amazme/evals
```

`eval:host` 跑普通评测；`eval:docs` 跑成对文档评测，可传 `--provider`、`--model`、`--runs-per-variant`、用例路径和 `-t`。

```bash
npm run eval:docs -w @amazme/evals -- evals/extensions.docs.eval.ts --runs-per-variant 1
npm run build -w @amazme/evals
```

`without_docs` 和 `with_docs` 使用相同后端、独立临时工作区、账号副本和会话。后者额外提供现行 Python 契约及其提示词入口。默认仅开放工作区文件读写；插件用例再开放该会话插件。它们是本机助手的评测工作区隔离，不是操作系统沙箱；用户 Python 插件仍以本机用户权限运行。不要将这些结果解释为对不可信代码的安全隔离证明。

模型配置用例生成工作区中的 `provider.json`，由评测器验证声明的供应商、模型、协议和地址，再经真实账号/模型 API 应用。只向明确声明的本机 HTTP 替身发送固定测试凭据。覆盖已有 OpenAI Chat Completions 和 Anthropic Messages 协议，不再加载旧 TS 自定义供应商宿主。插件用例生成 `setup(api)` 工厂，由真实 Python 服务加载并向模型提供工具别名。

`src/plan.ts` 预先规划每个 `(case, variant, model, runNumber)`；`src/native.ts` 串行运行；`src/report.ts` 配对并计算差值。失败、缺失或重复结果阻止对应配对的结论，已有消耗仍计入运行总量。`.eval/<run>/` 保存协议摘要、计划、原始报告、完整已提交消息和实际后端 build_id。没有原始证据的历史运行数字不代表当前实现。

本包提供显式的模型能力评测，保留 Vitest 作为评测运行器；开发用的单元测试设施已移除。评测结果是该次模型运行的交付数据，不代表产品整体正确性。运行器的 Host 与借用凭据由 `backend/tools/eval_runtime.py` 持有。
