# dsh-pilot

> 契约化主-子代理调度的 DeepSeek Harness 插件：**主代理做驾驶员，子代理（flash 级廉价模型）指哪打哪。**
> Contract-driven master/subagent orchestration for DeepSeek Harness — the master agent plans and arbitrates, cheap subagents execute inside enforced contracts.

**状态：立项设计阶段，尚无实现。** 设计文档见 [DESIGN.md](DESIGN.md)（形态论证、DSH 真实扩展点调研、功能规格 P0/P1/P2、验证计划）。

核心思想：

- 主代理只产出**契约**（目标、文件白名单、验收命令），不亲手写业务代码；
- 子代理只收到契约 + 内联上下文，结构化回执（无散文）；
- 验收由插件代码亲自执行（exit code + git diff 白名单核验），零 LLM 复核；
- 分发形态 = Agent 预设（插件 + 极简 persona + 按需 Skill + AGENTS.md 模板），新建项目开箱即用。
