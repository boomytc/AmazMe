# 可复用工作流

按需选择本插件，才注册 `workflow`、`workflow_save` 和 `/workflows`。原生 CLI 使用 `-e <本包目录>`；宿主从插件选择中加载 session facet。没有第二个 agent loop、执行器或注册表。

工作流是 JSON 数据，默认保存到当前环境的 `.amazme/workflows/<name>.json`。以下计划先让一个独立会话分析，再执行明确的 Unix 检查：

```json
{
  "version": 1,
  "name": "inspect-project",
  "description": "分析当前项目并检查产物",
  "concurrency": 1,
  "maxJobs": 2,
  "jobTimeoutSeconds": 120,
  "stages": [
    {
      "name": "分析",
      "role": "work",
      "onFailure": "stop",
      "jobs": [
        { "kind": "agent", "name": "分析文件", "prompt": "读取 README.md，报告项目结构。", "tools": ["read"] }
      ]
    },
    {
      "name": "检查",
      "role": "verify",
      "onFailure": "stop",
      "jobs": [
        { "kind": "command", "name": "README 存在", "tool": "bash", "command": "test -f README.md" }
      ]
    }
  ]
}
```

保存使用 `workflow_save` 的 `{ "plan": <计划> }`；用户命令可用 `/workflows {"action":"save","plan":<计划>}`。`load` 返回当前 `version`；替换已有不同内容必须提供该版本作为 `expectedVersion`，外部改动会拒绝覆盖。同样内容不重复写入。文件保存遵守环境的条件发布和现有审批；中断保存不自动重放，应先 `load` 核对实际文件。

```text
/workflows templates
/workflows load inspect-project
/workflows run inspect-project 用户输入
/workflows list
/workflows status 任务编号
/workflows pause 任务编号
/workflows resume 任务编号
/workflows stop 任务编号
```

工具可用 `{ "action": "run", "plan": <计划>, "args": "用户输入" }`，或以 `path` 引用已保存的文件。名称简写只指向项目默认目录；显式路径可读取当前环境允许的其他目录，不自动发现并执行计划。`templates` 最多检查目录前 100 项，坏文件显示问题；`load` 最多读取 256 KiB。

阶段顺序执行，同阶段最多 1–8 个工作项并发。每份计划最多 16 个阶段、每阶段 32 个工作项，总数不得超过显式 `maxJobs`（1–128）；同一 Session 最多四个活跃工作流。每项具有 1–3600 秒的持久截止时间，包含模型请求、所选工具和审批等待。预算约束本插件准入的工作项；所选工具内部的行为仍由该工具管理。

`agent` 项创建所属的干净会话，只接收计划目标、该项提示、输入参数及已完成前置阶段的证据，不继承父会话聊天文本或同阶段未完成输出。模型在准入时固定，工具必须显式选择且仍受父会话可用范围限制；不提供 `subagent` 或工作流工具。已有插件、环境与工具生命周期继续生效。`command` 项使用普通 Bash/PowerShell 工具任务，命令按原文执行，`args` 不插入 shell。

`role` 支持 `work`、`verify`、`synthesize`。阶段的 `onFailure: stop` 取消并等待本阶段剩余工作，后续阶段不准入；`continue` 保留失败证据并继续。模型回答是报告，不能证明检查通过。只有 `verify` 阶段配置的全部命令成功、返回可靠零退出码且没有工具错误，才将 `verification` 标为 `passed`；失败或超时标为 `failed`，没有命令或缺少证据时标为 `unverified`。这只证明所配置命令的结果，检查是否充分覆盖目标由用户决定。

运行立即返回后台任务编号，前台会话可以继续工作。`pause` 持久阻止新工作准入，让已经开始的工作结束；有在途任务时显示 `pausing`。`resume` 继续剩余工作，重开会话不重做已完成项。`stop` 取消并等待所属会话、模型和工具清理。已中断的命令服从原工具的不安全重放策略，保留 `unverified`，不自动重跑；在途模型请求遵守原 Harness 恢复行为，不承诺请求恰好一次。

进度与结果以已有任务检查点和终态为准，索引只保存编号，控制文档只保存暂停意图。最终回执通过普通工具结果呈现，CLI/Web 沿用现有任务图、对话和工具卡片；状态包含阶段计数、工作项任务编号、答案/工具记录引用、子会话编号和实际 token 数。每项摘要最多 6000 字符，后续阶段证据最多 40000 字符并有截断标记，原始记录保留。停止后的结果通过 `status` 查询。

`src/plan.ts` 定义数据格式，`files.ts` 处理模板，`job.ts` 执行所属工作，`run.ts` 处理阶段，`session.ts` 提供工具与命令。修改源码后结束或取消当前任务，再用 `/reload` 构建切换；移除插件保留历史，未结束的任务需恢复插件或取消。Unix 已实跑，PowerShell 复用现有实现，未实测 Windows。
