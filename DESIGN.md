# dsh-pilot 设计文档

> **契约化主-子代理调度插件：主代理做驾驶员，子代理（flash 级廉价模型）指哪打哪。**
> 版本：v0.1-draft · 状态：立项设计（未实现） · 最后更新：2026-09-05

---

## 1. 背景与问题定义

### 1.1 模型经济学分层

| 角色 | 典型模型 | 强项 | 弱项 | 价格 |
| --- | --- | --- | --- | --- |
| 主代理（驾驶员） | 旗舰级模型 | 规划、工程状况判断、低幻觉、全面思考 | 慢 | 高 |
| 子代理（执行手） | DeepSeek-v4.1 flash 级 | AAII 工程落地评分最强、Coding 能力强、快 | **全模型中最严重的幻觉**；不适合摸清工程状况与规划 | 低 |

结论：任何"让子代理自己摸清状况再自由发挥"的用法都在放大它的短板；任何"主代理亲自写代码"的用法都在浪费它的价格。正确分工是——**主代理负责理解、规划、立契约、监督、裁决；子代理只在契约边界内执行与自测。**

### 1.2 已确诊的反模式（来自实践复盘）

1. **微观管理反模式**：主代理先摸清现场、写好大半代码再丢给子代理 → 推理 token 在主代理侧已烧掉，子代理沦为搬运工。
2. **LLM 验证 LLM**：主代理不轻信子代理汇报，自己重看源码或再派一个子代理"复查" → 不确定性相乘，token 翻倍，产出反而更差。
3. **上下文反复重载**：同一批文件在主代理和子代理两个 context window 里重复加载解析。
4. **交接文档屎山**：P1/P2/P3 路线图、临时脚本、验收记录散落工作区，污染后续所有会话。
5. **过度工程回摆**（严格方案的反面陷阱）：海量小需求被迫走全套流程 → 调度开销倒挂、伪单测泛滥、防御性编程臃肿。

### 1.3 设计目标与非目标

**目标**

- 用**代码层硬约束**（而非 prompt 祈祷）固化"契约派发 → 确定性门禁 → 结构化回执"闭环。
- 主代理上下文里只存在：任务矩阵 + 紧凑 verdict；子代理上下文里只存在：契约 + 白名单文件。
- 验收只看客观信号（exit code、git diff 范围），零 LLM 复核。
- 协议学习成本趋近于零：主代理靠极简角色段 + 按需 Skill，子代理只收到契约本身。
- 分级流水线：小微需求走快速通道，不因流程产生过度测试/过度防御。

**非目标**

- 不替代官方 `subagent` / `workflow` / `subagent_fork` 工具——本插件是它们之上的**契约封装层**。
- 不做多 Agent 群聊、角色扮演式 SOP（MetaGPT 路线）。
- 不修改 DSH 引擎/官方包，一切走公开扩展点。
- 不追求强制锁（advisory guardrail 即可，与 dsh-file-claim 同一哲学，见 §10）。

---

## 2. 形态决策：四位一体，预设分发

### 2.1 候选形态对比

| 形态 | 约束强度 | Token 成本 | 系统能力 | 迁移成本 | 结论 |
| --- | --- | --- | --- | --- | --- |
| AGENTS.md | 软（靠模型自觉） | 每会话全量载入 | 无（不能执行任何物理动作） | 每个仓库拷一份 | ❌ 只放项目侧最小声明 |
| Skill | 软 | **按需加载**（目录摘要在场，正文调用才载入；`invocation` 策略可控模型/用户可见性，见 §3.6） | 无 | 随预设走 | ✅ 详细协作手册的载体 |
| 预设 persona 提示段 | 软 | 常驻但可极简（**目标一行 <80 token**，可配置为完全不注入） | 无 | 随预设走 | ✅ 一行指针：工具路由规则 |
| 动态插件（cordis_define） | **硬** | 零（逻辑在代码里） | 有 | **进程本地，重启即失** | ⚠️ 只作开发期迭代手段 |
| **仓库插件（npm 包）** | **硬** | 零 | 有（guard/事件/shell/子代理 API） | 一次安装全局生效 | ✅ 约束载体 |
| **Agent 预设（preset）** | 组合容器 | 取决于组合内容 | 组合 | 一个目录，任何会话可选用 | ✅ **分发形态** |

### 2.2 结论：分层职责

```
┌─────────────────────────────────────────────────────────┐
│  Agent 预设  dsh-pilot  （~/.dsh/.agent-presets/ 下）      │
│  ├── agent.cordis.yml   组合定义（copy 自 standard + 增量）│
│  ├── preset.yml         名称/描述元数据                    │
│  ├── skills/pilot-playbook/   详细协作手册（按需加载）      │
│  └── templates/AGENTS.pilot.md  项目侧模板（可选）          │
│                                                         │
│  其中引用插件行：                                          │
│  └── dsh-pilot（npm 包 / link 仓库）                       │
│       = 契约工具 + 门禁 + 守卫 + 模型路由 + 极简 persona 段  │
└─────────────────────────────────────────────────────────┘
```

- **预设是"新建项目直接可用"的答案**：预设挂在用户根，与具体项目解耦；新会话选 `dsh-pilot` 预设即获得全套能力。项目侧唯一可选产物是 AGENTS.md 模板（声明测试命令），缺失时插件靠契约必填字段照常工作。
- **插件是约束载体**：契约 schema、门禁执行、文件守卫、模型路由全部在代码里，模型无法绕过、无需学习。
- **Skill 是成本阀门**：协作细节（契约怎么写、tier 怎么选、失败怎么处理）不进系统提示，主代理首次需要时 `skill('pilot-playbook')` 载入。
- **AGENTS.md 模板是项目侧声明**：只写测试命令与目录边界（给人和主代理看），不写协作流程。

### 2.3 上下文零常驻纪律（2026-09-18 用户拍板，对照 agent-teams 反面教材）

pilot 对主会话上下文的占用必须趋近于零，三档曝光由插件 config `exposure` 控制：

| 档位 | persona 段 | skill 对模型 | 常驻成本 | 适用 |
| --- | --- | --- | --- | --- |
| `pointer`（默认） | 一行指针（<80 token）："改代码走 pilot_dispatch；复杂任务先载入 pilot-playbook" | 可见一行摘要，按需载入正文 | ~150 token | 希望主代理自发走契约流程 |
| `silent` | **完全不注入** | `modelInvocable: false`，模型目录里不存在 | **0** | 用户自己掌控节奏，显式调用 `/skill pilot-playbook` 或直接点名 pilot_dispatch 才启用 |

配套约束（防"agent-teams 式 14 工具常驻"）：

- P0 只注册 **`pilot_dispatch` 一个工具**，description 控制在一两句话；契约字段语义、写作技巧全部放 skill body，不堆在工具 schema 里。P1 的 status/merge/batch 工具同理从简。
- 不做"固定核心协议常驻系统提示"。协议的权威载体是 skill 正文与工具 schema 本身，模型需要时自取。

### 2.4 为什么不是"动态插件"分发

动态 Cordis 插件（`cordis_define`）是进程本地的临时扩展，重启即失，适合**开发期快速迭代**本插件的 guard/门禁逻辑；但用户的诉求是长期改善对话体验，分发形态必须是可以进 npm / 可以被预设引用的**仓库插件**（与 dsh-file-claim 同一形态：`index.mjs` host 入口 + `cordis.patch.yml` + `dsh plugin add`）。

---

## 3. 运行时基座调研结论（2026-09-05 实测当前 DSH 运行时）

**核心结论：不需要造 harness。** 官方子代理基座已原生提供本设计所需的全部关键能力，插件是"封装 + 裁决"，不是"重新发明"。

### 3.1 官方子代理基座（`subagents` 服务）已具备

`SubagentStartRequest` 原生字段（实测签名）：

| 字段 | 类型 | 本设计用途 |
| --- | --- | --- |
| `prompt` | `ContentBlock[]` | 注入契约（子代理只见契约，不见主会话） |
| `agentOptions` | `{provider, model, reasoningEffort, maxTokens}` | **钉死子代理模型**为 flash 级 |
| `outputSchema` | `ObjectJsonSchema` | **强制结构化回执**，物理消除散文汇报 |
| `toolFilter` | `{allow?, deny?}` | **子代理工具收权**（按 tier 裁剪） |
| `persona` | `string` | 子代理极简角色（"你是执行手，只做契约内的事"） |
| `maxDepth` | `number` | 防止子代理再派子代理失控 |
| `label` / `parent` / `signal` | — | 目录展示 / 父子关系 / 取消 |

返回 `SubagentRun { id, localAgent, result: Promise<SubagentResult>, dispose() }`；`SubagentResult { output, structured, diagnostic, stopReason }` —— `structured` 即 outputSchema 校验后的 JSON。

持续会话能力：`startContinuable` + `sendMessage` → **失败重试可以 steer 同一个子代理**（把 stderr 尾部喂回），而不是新开会话重烧上下文。

能力探测：`SubagentProvider.capabilities = { agentOptions, outputSchema, depthLimit, toolFilter, persona }` —— 不同 provider 能力不同，**运行时必须探测并降级**（如 provider 不支持 outputSchema，则退回"契约末尾附回执格式 + 插件解析校验"）。

### 3.2 拦截与门禁扩展点

| 扩展点 | 模式 | 用途 |
| --- | --- | --- |
| `tools.guard((exec) => string \| undefined)` | 同步守卫 | **文件白名单硬约束**：返回字符串即拒绝。可按 `exec.agent.id` 匹配活动任务白名单 |
| `tools/pre-execute` | waterfall（allow/deny/ask） | 守卫的另一落点；可审计日志 |
| `tools/post-execute` | waterfall（replace/block） | 回执压缩、结果改写 |
| `tools/execute` / `tools/result` | around / emit | token 与耗时度量埋点 |
| `fs/write-intent` / `fs/edit-intent` | **单槽 waterfall** | ⚠️ 已被官方 `dsh-fs-observation-policy` 占用（dsh-file-claim 实战经验）——第三方守卫**只能走 `tools/pre-execute` 或 `tools.guard`** |
| `shell` 服务 | `run(spec)` | 门禁执行 `acceptance_cmd`，拿真实 exit code |
| `agent/request` | waterfall | 逐次替换 `LlmCallConfig`（备用模型路由手段） |

### 3.3 模型路由三条路（按优先级）

1. **逐次派发钉死**：`pilot_dispatch` 内部给 `SubagentStartRequest.agentOptions = { provider, model }`（配置驱动，默认 flash 级）。最直接。
2. **会话级默认**：`subagentModelSelection` 设置（"delegation tools 组合时读取的单例设置"）——预设层面把子代理默认模型调成廉价档。
3. **自定义 Provider 包装**：`subagents.registerProvider` 注册带 `agentRouteDefaults` 的包装 provider。最重，仅前两条不够时用。

### 3.4 观测与基础设施

- `subagent/start`、`subagent/end` 事件 + `subagents.listChildren(parentSessionId)` → 进度追踪，主代理可查询而非盲等。
- `tokenMeter.measure(session)` → 按会话计量 token，主/子成本分离统计。
- `agentTeams`（createTask/listTasks/updateTask/waitForChange）→ 官方任务矩阵设施（P2 再探，先用插件自维护的轻量矩阵）。
- `settings.register(ns, schema)` → 插件配置命名空间（P2）。
- `skills.register(...)` → 插件自注册 playbook skill，进预设作用域层。

### 3.5 与现有资产的关系

| 资产 | 关系 |
| --- | --- |
| 官方 `subagent` / `subagent_fork` / `workflow` 工具 | **共存不替代**。它们是通用委派原语；`pilot_dispatch` 是带契约与门禁的特化封装。主代理仍可对探索性任务用裸 `subagent` |
| `dsh-file-claim`（用户已有插件） | **互补不重复**。file-claim 解决跨会话并行写的文件认领（advisory）；pilot 解决会话内主-子契约派发。同一工作区可共存（pilot 的守卫按 agent.id，file-claim 的守卫按会话认领，不冲突） |
| `agentTeams` | P2 的可选任务矩阵后端，MVP 不依赖 |
| 社区插件（agent-teams / ha-orchestrator / odai / sofagent 等） | 详见 §11。结论：无同构实现，但编排面被部分覆盖；允许 fork/抽取精华（§11.3），F15/F16/F19 优先评估集成而非自造 |

### 3.6 上下文预算控制（2026-09-18 补测，回应"工具/协议常驻侵占上下文"）

为 §2.3 零常驻纪律实测的官方机制，全部可用：

- **`skills.register` 的 `SkillRegistration.invocation: {modelInvocable, userInvocable}`**：精确控制 skill 可见性。`modelInvocable: false` 时模型目录里根本没有它，仅用户可显式调用——"完全不入上下文"的官方机制。默认可见时模型也只见一行 `name + description` 摘要，正文由 `skill()` 工具按需载入（registry 自述 "loads full skill bodies on demand"）。
- **`tools.presentAs('native' | 'ptc' | 'both')`**：scoped 声明，预设 standing composition 上调用即覆盖其下所有 agent；PTC 模式把工具以编程目录形式呈现而非全量 schema 常驻上下文。是全预设级的激进降本档位，**pilot 默认不动它**（影响面是所有工具，不只 pilot 的），列为预设可选优化。
- **`tools.register` / `tools.restrict` 均支持 agent 作用域**：scoped 注册遮蔽全局、restrict 只遮蔽全局工具，可按 `agent.ctx` 逐代理裁剪工具面（与子代理 `toolFilter` 互补）。
- 社区先例：[vibeinging/dsh-tool-search](https://github.com/vibeinging/dsh-tool-search)（按需工具发现 + 渐进 schema 披露）证明"工具不常驻、用时再取"在 DSH 上成立；反面教材是 dsh-agent-teams 的"固定核心协议 + 14 个业务工具常驻队长会话"（§11.1）。

---

## 4. 总体架构

### 4.1 角色拓扑

```
 用户
   │ 自然语言需求
   ▼
┌──────────────── 主代理（旗舰模型，驾驶员） ────────────────┐
│ 理解需求 · 摸清工程状况（只有它做）· 维护任务矩阵           │
│ 起草契约 · 看 verdict 推进 · 不亲手写业务代码               │
└──────────────────────┬───────────────────────────────────┘
                       │ pilot_dispatch(契约)  ← Schema 强制，无 code 字段
                       ▼
┌──────────────── dsh-pilot 插件（Host，纯代码裁决） ────────┐
│ ① 组装子代理 prompt = 契约 + 内联上下文                     │
│ ② subagents.start(outputSchema, toolFilter, agentOptions) │
│ ③ 文件白名单守卫（tools.guard，按子代理 agent.id）          │
│ ④ 门禁：shell 跑 acceptance_cmd → 真实 exit code           │
│ ⑤ 核验：git diff --name-only 对比白名单 & 回执真实性        │
│ ⑥ 失败：stderr 尾部 steer 回同一子代理重试（≤max_retries）  │
└──────────────────────┬───────────────────────────────────┘
                       │ verdict（紧凑 JSON，<200 token）
                       ▼
              主代理只看 verdict，零 LLM 复核
```

### 4.2 契约（Contract）— 主代理 → 插件

`pilot_dispatch` 参数 schema（**刻意没有 code/patch 字段**，主代理物理上无法递代码）：

```json
{
  "goal": "一句话目标",
  "detail": "需求细节、接口签名约定、边界条件",
  "context": [
    { "path": "src/auth.ts", "note": "TokenService 在此；签发签名 sign(uid: string): string" }
  ],
  "allowed_files": ["src/auth.ts", "tests/auth.test.ts"],
  "acceptance_cmd": "pnpm vitest run tests/auth.test.ts",
  "tier": "standard",
  "max_retries": 2
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `goal` | ✅ | ≤140 字 |
| `detail` | ✅ | 契约正文。"合同定好后不许有自己的理解"的载体 |
| `context` | 建议 | **幻觉防御关键**：主代理把相关文件路径+接口摘要内联进来，子代理零摸索 |
| `allowed_files` | ✅ | 修改白名单（相对路径，支持目录前缀） |
| `acceptance_cmd` | tier=standard 必填；tier=fast 可省略 | 客观验收命令 |
| `tier` | 默认 `standard` | `fast` / `standard`（见 §6.1） |
| `max_retries` | 默认 2 | 超限后 verdict=FAIL 上交人类 |

### 4.3 回执（Receipt）与裁决（Verdict）

子代理 `outputSchema`（子代理只能返回这个，无散文）：

```json
{
  "type": "object",
  "properties": {
    "status": { "enum": ["completed", "blocked"] },
    "summary": { "type": "string" },
    "files_changed": { "type": "array", "items": { "type": "string" } },
    "test_ran": { "type": "boolean" },
    "exit_code": { "type": "integer" }
  },
  "required": ["status", "files_changed", "test_ran"]
}
```

插件返回主代理的 verdict（`output.render` 控制模型所见，紧凑）：

```json
{
  "verdict": "PASS",
  "files_changed": ["src/auth.ts", "tests/auth.test.ts"],
  "gate": { "cmd": "pnpm vitest run tests/auth.test.ts", "exit_code": 0 },
  "attempts": 1,
  "child": { "model": "deepseek-v4.1-flash", "tokens": 12345 }
}
```

`verdict ∈ { PASS, FAIL, BLOCKED, ESCALATED }`。FAIL 时附 `error_tail`（截断 stderr，确定性内容）与 `diff_stat`；ESCALATED 表示重试超限，需要人类或主代理改契约。

**真实性核验**（针对 flash 幻觉）：插件自己执行 `git status --porcelain` / `git diff --name-only`，与回执 `files_changed` 交叉比对；回执虚报（声称改了没改/没改声称改了）直接判 FAIL 并把实际 diff 作为反馈。回执里的 `exit_code` 仅作交叉校验，门禁以插件亲自执行的为准。

---

## 5. 功能规格

### 5.1 P0 — MVP（一个周末可验证的最小闭环）

| # | 功能 | 载体 |
| --- | --- | --- |
| F1 | `pilot_dispatch` 契约工具：schema 强校验、组装子代理 prompt、`subagents.start` 派发、等待 result | Host 插件 |
| F2 | 结构化回执：`outputSchema` 注入；provider 不支持时降级为"契约附回执模板 + 插件 JSON 提取校验" | Host 插件 |
| F3 | 确定性门禁：插件用 `shell` 亲自执行 `acceptance_cmd`，取真实 exit code | Host 插件 |
| F4 | 白名单守卫：`tools.guard` 按 `exec.agent.id` 匹配活动任务，拒绝对白名单外路径的 write/edit；bash/pwsh 走尽力解析（fail-open，同 file-claim 边界） | Host 插件 |
| F5 | diff 范围核验 + 回执真实性核验 | Host 插件 |
| F6 | 失败重试环：stderr 尾部 steer 回同一 continuable 子代理，≤max_retries | Host 插件 |
| F7 | 极简 persona 段（`systemPrompt.section` 自注册，**一行 <80 token**）："改代码走 pilot_dispatch；复杂任务先载入 pilot-playbook"。`exposure: 'silent'` 时整段不注入（§2.3） | Host 插件 |
| F8 | `pilot-playbook` Skill（`skills.register`，预设作用域层）：契约写作指南、tier 选择、失败处理。默认 `modelInvocable: true`（模型见一行摘要、按需载入正文）；`exposure: 'silent'` 时 `modelInvocable: false`，仅用户显式调用（§3.6） | 插件注册 / 预设目录 |
| F9 | AGENTS.md 项目模板（预设 `templates/` 内，人工可选拷贝） | 预设 |

### 5.2 P1 — 效率与并行

| # | 功能 |
| --- | --- |
| F10 | 分级流水线 tier=fast：小微改动不强制 acceptance_cmd，门禁降级为"零回归"（配置的全量 lint/typecheck/现有测试）+ diff 行数上限 |
| F11 | 批处理 `pilot_dispatch_batch`：多个微需求聚合为一个 chore 包，一次派发、一次门禁 |
| F12 | worktree 并行隔离：`git worktree add .dsh-pilot/wt-<taskId>`，子代理 cwd 限定其中；`pilot_merge` 冲突预检后合并回收（非 git 工作区自动降级为串行+守卫） |
| F13 | `pilot_status`：任务矩阵查询（活跃任务、子代理 activity、门禁结果），数据来自 `subagents.listChildren` + 插件状态 |
| F14 | 成本计量：`tokenMeter.measure` 按主/子会话分离统计，verdict 附 `child.tokens` |

### 5.3 P2 — 慢慢完善（立项不做，接口预留）

| # | 功能 | 备注 |
| --- | --- | --- |
| F15 | Client 任务矩阵面板（Slot UI）：任务状态、门禁绿灯、成本曲线 | 需先查 `Slots.listSubTree` 选挂载点 |
| F16 | DAG 编排：契约间声明依赖，插件拓扑调度 | 可先评估官方 `workflow` 工具承载 |
| F17 | 幻觉统计与自动降级：回执虚报率、门禁失败率超阈值时提示人类换子代理模型 | 数据来自 F5/F14 累积 |
| F18 | `settings` 命名空间配置页（模型档位、默认 tier、行数上限等） | `settings.register` |
| F19 | 与 `agentTeams` / goal 工具集成：长目标自动拆解为契约序列 | 需先探 `agentTeams` 契约 |
| F20 | worktree 生命周期 UI 与手动接管入口 | 依赖 F15 |

---

## 6. 关键机制详设

### 6.1 分级流水线（防御"严格方案回摆"陷阱）

| | tier=fast（小微改动） | tier=standard（常规特性/修复） |
| --- | --- | --- |
| 判定 | 改动 ≤2 文件、非核心逻辑、UI/文案/常量/单行修复 | 跨模块、核心状态、接口变更 |
| 隔离 | 不建 worktree，直接当前工作区 | worktree（F12 落地后） |
| 验收 | **零回归门禁**：配置的全量检查命令不挂即可；**禁止新增测试** | **契约门禁**：acceptance_cmd 必须过 |
| diff 约束 | 白名单 + 改动行数上限（默认 100 行，可配） | 白名单 |
| 执行者 | 可派子代理，也允许主代理直接改（persona 不禁止） | 必须子代理 |

海量微需求 → 主代理先**聚合**（F11 batch），一次派发一次门禁，不为每个 typo 各跑一遍流水线。

### 6.2 幻觉防御五件套（针对 flash 的最强幻觉）

1. **零摸索**：`context[]` 内联接口签名与相关文件摘要，子代理不需要"先摸清工程状况"。
2. **零散文**：`outputSchema` 结构化回执，物理上没有自由发挥的空间。
3. **交叉核验**：回执 `files_changed` vs 实际 `git diff --name-only`，虚报即 FAIL。
4. **客观门禁**：exit code 由插件亲自跑命令获得，不信回执自报的 `exit_code`。
5. **确定性反馈**：重试只喂 stderr 尾部与 diff 摘要（确定性内容），不喂主代理的主观猜测。

### 6.3 成本控制

- 主代理常驻增量：persona 段一行 <80 token（`exposure: 'silent'` 时为 **0**）；playbook 按需载入（Skill 目录至多一行摘要在场，见 §2.3/§3.6）。
- **工具面零常驻纪律**：P0 只注册 `pilot_dispatch` 一个工具，description 控制在一两句话；契约字段语义、写作技巧全部放 skill body，不堆在工具 schema 里——杜绝 agent-teams 式"14 工具 + 固定协议常驻队长会话"。
- 子代理零协议学习：prompt = 契约本身，没有任何协作哲学灌输。
- 主代理收到的只有 verdict JSON（目标 <200 token），子代理的中间过程、工具流水、思考全部留在子会话。
- 门禁/核验/守卫全部是代码，零 LLM 调用。
- F14 提供每任务主/子 token 账单一眼可查——成本是否改善用数据说话，不靠感觉。

### 6.4 工件卫生（无屎山）

- 守卫拒绝子代理在白名单外创建任何文件（`.md` 路线图、临时脚本、验收记录天然被白名单挡住）。
- 插件自身状态（任务矩阵、审计行）存 `${DSH_HOME}` 侧或会话内内存，**永不写工作区**；worktree 目录统一 `.dsh-pilot/wt-*` 并在 merge 后回收。
- 子代理完成即 `dispose()`，无状态残留。

### 6.5 并行与冲突（F12 落地后）

- 每个并行任务一个 worktree + 一个子代理，物理隔离。
- 合并由插件执行：`git -C <wt> diff` → 主工作区 apply / merge；冲突则不自动合并，verdict=BLOCKED 上交主代理决定。
- 与 `dsh-file-claim` 共存时，跨会话冲突由 file-claim 的认领层兜底（不同维度，互不替代）。

---

## 7. 仓库与预设布局

### 7.1 插件仓库（与 dsh-file-claim 同构的发布面/工程面）

```
dsh-pilot/
├── DESIGN.md            本文档
├── README.md            对外契约（发布时英文 + README.zh-CN.md 双语，遵 dsh-file-claim 惯例）
├── index.mjs            插件入口（唯一 host 面文件）：工具注册、守卫、事件挂接、门禁执行
├── pilot-core.mjs       纯逻辑核心（零 DSH 依赖、可独立单测）：契约校验、白名单匹配、
│                        diff 解析、回执核验、verdict 判定、shell 命令路径提取
├── cordis.patch.yml     bundle 声明（insert dsh-pilot）
├── package.json         files 白名单 = 发布面
├── test/                node --test：pilot-core 纯函数单测 + index mock-ctx 集成测试
└── dev/                 ❌ gitignore：REQUIREMENTS、HANDOFF、评估笔记、夹具
```

约束沿用 dsh-file-claim 已验证的纪律：纯 ESM 无构建、只消费 host 公开服务、不发布服务（无需 isolate realm）、无 Browser 侧（P2 面板除外）、拦截只走 `tools.guard` / `tools/pre-execute`、失败大声报告。

### 7.2 预设目录（分发形态）

```
~/.dsh/.agent-presets/dsh-pilot/
├── preset.yml           name / description
├── agent.cordis.yml     copy 自 standard，增量：
│                        - dsh-pilot 插件行（link 或 npm 名 + config）
│                        - （可选）subagentModelSelection 默认模型调廉价档
├── skills/pilot-playbook/SKILL.md   （若不走插件 F8 自注册，则以目录形态放这里）
└── templates/AGENTS.pilot.md        项目侧模板
```

发布路径：开发期 `dsh plugin --profile web add -w link:D:\Build\dsh-pilot`；稳定后 `npm publish` + 他人 `dsh plugin add dsh-pilot`。预设验证：`agentPresets.standingKeyFor('dsh-pilot')` mount-validate 通过后开真实会话验收。

### 7.3 AGENTS.pilot.md 项目模板（可选，全文即这些）

```markdown
## pilot 验收约定
- 全量回归命令（tier=fast 零回归门禁）: `<你的 lint+typecheck+test 命令>`
- 测试目录: `tests/`
- 子代理交付纪律: 不新增文档/脚本类文件；改动不超出任务白名单
```

---

## 8. 验证与测试计划

1. **pilot-core 单测**（node --test）：契约 schema 校验、白名单 glob 匹配（目录前缀/精确路径/否定）、`git diff --name-only` 解析、回执交叉核验真值表、verdict 状态机迁移。
2. **mock-ctx 集成测试**：模拟 tools/subagents/shell/tokenMeter 服务，跑通 dispatch→guard→gate→verdict 全链路（dsh-file-claim 的 mock 模式可直接借鉴）。
3. **预设 mount-validate**：`standingKeyFor('dsh-pilot')` 通过（无服务发布、无未激活行）。
4. **真实会话验收**（人工清单）：
   - 派一个真实 tier=standard 小任务（改一个函数+补一个测试），确认：子代理模型=配置档、白名单外写入被拒、门禁真实执行、主代理只见 verdict。
   - 制造一次门禁失败，确认 stderr 尾部 steer 重试与超限 ESCALATED。
   - 检查工作区无任何交接文档残留。

---

## 9. 里程碑

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M0 | 本设计文档评审定稿 | 用户确认 |
| M1 | P0：pilot-core + index.mjs + 守卫 + 门禁 + persona 段 | §8.1/8.2 全绿 + §8.4 真实任务通过 |
| M2 | 预设打包 + playbook skill + AGENTS 模板 | standingKeyFor 通过，新会话开箱可用 |
| M3 | P1 按需（tier/batch/worktree/status/成本） | 每个 F 单独 commit 单独验收 |
| M4+ | P2 远景，按使用痛点优先级插队 | — |

---

## 10. 风险与开放问题

| 风险/问题 | 现状判断 | 对策 |
| --- | --- | --- |
| 守卫对任意 bash/pwsh 写入 fail-open（`echo > file`、脚本间接写） | 与 file-claim 同一公认边界 | 文档明示 advisory 定位；复用 file-claim 已验证的 shell 路径提取思路（重定向 + 显式写命令）提高覆盖率；worktree（F12）提供更强的物理隔离补位 |
| provider capabilities 不齐（无 outputSchema/toolFilter） | `SubagentCapabilities` 五字段均可选 | 派发前探测，降级链：outputSchema→契约附回执模板+插件校验；toolFilter→仅靠 guard；能力全无时拒绝派发并大声报错 |
| `subagents.start` 的 provider 名称与当前部署绑定 | 部署相关 | config 可配 provider 名，运行时 `subagents.list()` 校验存在性，缺失时给出可用列表 |
| worktree 在非 git 工作区不可用 | 必然场景 | 自动降级：串行派发 + 守卫 + diff 快照比对（插件自行快照白名单文件哈希） |
| 主代理"忍不住"直接写代码 | 软约束管不住概率模型 | 默认软引导（persona + 契约工具是最省力路径，模型自然倾向调用）；提供 `strictPlanner: true` 配置，开启后用会话级 guard 在主代理存在未完成契约时拒绝其 write/edit——默认**关**，避免误伤 tier=fast |
| 门禁命令本身有害（acceptance_cmd 被滥用） | 命令由主代理生成、插件执行 | 沿用会话既有 approval/沙箱策略执行 shell；不在插件内额外发明权限体系 |
| `exposure: 'silent'` 下主代理不会自发使用 pilot | 双模式的固有权衡 | 默认 `pointer`（一行指针）保自发可用；`silent` 供用户完全掌控启用时机，README 写明两档行为差异 |
| 生态位被社区插件挤占 | agent-teams（1.7k★）编排面已很全 | 差异化定位不动摇：pilot 卖的是**确定性裁决**（exit code 门禁 + diff 交叉核验）与**成本分层**（tier + token 账单），不是编排；见 §11 |

---

## 11. 开源生态对照调研（2026-09-18）

调研问题：GitHub 上是否已有与本设计同构、可直接复用的实现？**结论：没有完全同构者。** "契约派发 + 插件亲自跑验收命令 + diff 白名单 + 回执交叉核验 + tier 成本分层"这个交集目前无人占据；但编排面已被部分覆盖，必须明确差异化边界与集成策略。

### 11.1 DSH 生态内（最直接相关）

| 项目 | 它是什么 | 与本设计的重叠 | 关键差异 | 处置 |
| --- | --- | --- | --- | --- |
| [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)（1.7k★，v0.1.20，活跃） | 队长式多智能体**团队**：可续聊成员、带依赖任务 DAG、自动领取、成员邮箱、Web DAG 面板、默认"需求→实现→验证→审查→集成"质量门禁、逐成员 provider/model/reasoning_effort、memberMaxDepth=0 | 角色分工、任务矩阵、模型钉死、防嵌套外包、DAG（F16）、UI 面板（F15） | ① 其"验证/审查"是**派给子代理的 LLM 任务**，不是插件亲自跑 acceptance_cmd 取 exit code；② 官方自述"第一版范围控制是完成时审计，不是 host 写入拦截"（无 tools.guard 白名单）；③ 无 tier 分级——全员全流程，协议重（持久状态、邮箱、14 工具）；④ 无 token 成本账单 | **不重复造**。要"长期团队"用它；pilot 定位轻量契约裁决层，F19 保留集成入口 |
| [Saktawdi/dsh-ha-orchestrator](https://github.com/Saktawdi/dsh-ha-orchestrator)（6★） | 模型 HA 熔断回退 + `orchestrate` 五模式（fanout/pipeline/supervisor/map-reduce/router）+ 自定义子代理（provider/model/effort、工具黑白名单、回退链、outputSchema、预算、resume） | 模型钉死、工具收权、结构化输出——**实证了 §3 基座结论在社区已被走通** | 验证靠 supervisor 子代理评审——正是本设计拒绝的"LLM 判卷"；无门禁、无白名单、无成本分层 | 借鉴其模型回退链（启动失败自动切备用模型）补 pilot 的 provider 降级链 |
| [orziz/odai](https://github.com/orziz/odai) | 任务治理框架：控制器+角色能力路由（planner/researcher/frontend 映射 provider/model）+ 项目守卫 hooks（PreToolUse 保护只读路径、Stop 时跑声明的验收命令，零依赖 runtime 生成 6 宿主适配器） | **验收命令门禁、只读路径保护、角色路由、skill+插件+预设的分发形态**——独立印证了 §2 形态结论与 §6 门禁思路 | 项目级静态策略（`.odai/hooks.json`），不是逐契约派发；其模式是"子代理只读/返回 patch、controller 亲手写码"，与 pilot"子代理写码、主代理不写"恰好相反 | 互为印证，无代码复用；其 hooks runtime 的零依赖多宿主生成思路可参考 |
| [KongFangXun/sofagent](https://github.com/KongFangXun/sofagent) | 提交时审计：24 条 git diff 确定性规则（密钥/越界/注入）、HMAC 防篡改链、快照回滚、DSH 插件族走 `tools/pre-execute` | diff 硬证据审计、越界编辑检测 | commit 时全仓审计，不是派发时按契约白名单 | 列为可选集成：验收命令里挂 `sofagent-audit` 增强门禁，不自建规则引擎 |
| [dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing)、[dsh-verification-receipt](https://github.com/030611/dsh-verification-receipt) | token 计费页 / 每轮工具结果 JSONL 摘要 | F14 成本计量的展示面 | — | F14 只做 verdict 附 `child.tokens`；完整成本页优先评估装 billing 而非自造 UI |

### 11.2 跨生态（Claude Code 等，间接印证）

- **Claude Code 官方**：subagent frontmatter 已原生支持 `isolation: worktree`（子代理自动进 worktree、扫尾回收、锁）与逐子代理选模型——worktree 隔离（F12）与模型分层是官方认定的主流方向；但无契约、无 exit-code 门禁、无回执核验。
- [ruvnet/ruflo](https://github.com/ruvnet/ruflo)（claude-flow）：Claude Code/Codex 的 swarm meta-harness，重 prompt/hooks 编排，无确定性门禁。
- [vibe-kanban](https://github.com/BloopAI/vibe-kanban) / [claude-squad](https://github.com/smtg-ai/claude-squad) / Fusion / agent-kanban：worktree 并行会话管理（看板/TUI），面向人驾多会话；Fusion 的 plan-review-execute 门禁是"阶段人工审批"，不是 exit-code 裁决。
- [Arize 2026-08 分析](https://arize.com/blog/how-cheap-models-changed-multi-agent-economics/)与 COPE/Writer 论文：orchestrator-executor 经济学（贵模型规划、廉模型执行、编排能力有下限）已成行业共识——印证 §1 的问题定义，也意味着这个方向会有更多人做，差异化必须锁在"裁决可信度"上。

### 11.3 复用与 fork 策略（2026-09-18 用户拍板：吸取精华、剔除糟粕，允许 fork 独立改动）

**代码级复用：从"零依赖不引入"升级为"选择性抽取"**（四个项目均 MIT，抽取须保留版权头）：

| 来源 | 处置 | 具体动作 |
| --- | --- | --- |
| dsh-ha-orchestrator | **抽取** | 模型回退链（角色级 fallbacks，启动失败/模型错误自动切换）与自定义子代理定义的持久化格式，补进 pilot 的 provider 降级链（§10 风险表的升级版）。模块边界清晰，按文件抄录 |
| dsh-agent-teams | **不整体 fork** | TS 双端构建链（tsdown client bundle）、高频演进（188 commits）、邮箱/DAG/UI 与轻量定位不符——整体 fork 等于收养一列重火车。若做 F16/F19：① 洁净室重写 DAG 拓扑调度小块（注明灵感来源）；② 用户要完整团队面时直接安装它共存（F19 集成方案不变） |
| odai | 参考思路 | hooks runtime 的零依赖多宿主生成思路可参考；宿主不同，无直接抽取价值 |
| sofagent | 只集成不 fork | `acceptance_cmd` 里可挂 `sofagent-audit` 增强门禁 |

**糟粕剔除清单**（对照社区反面教材逐条规避，均有官方机制兜底，见 §3.6）：

1. ❌ agent-teams 的"固定核心协议常驻 + 14 个业务工具全量注入队长会话" → pilot 对策：§2.3 零常驻纪律，P0 只注册 `pilot_dispatch` 一个工具，协议正文进 skill 按需载入，skill 可见性用 `invocation` 策略控制，`exposure: 'silent'` 时上下文占用为 0。
2. ❌ ha-orchestrator 的 supervisor LLM 评审判卷 → pilot 裁决永远是 exit code + diff 交叉核验（§4.3）。
3. ❌ agent-teams 的 `.agent-teams/` 状态目录写工作区 → pilot 状态只在会话内存 / `${DSH_HOME}` 侧（§6.4）。

**定位一句话**（写进 README）："agent-teams 给你一支团队，dsh-pilot 给你一份合同"——pilot 的壁垒是确定性裁决（exit code + diff 交叉核验）、成本分层（tier + token 账单）与零常驻纪律，这是现有项目都明确没有做的交集。

---

## 附录 A：已核实的 DSH API 摘要（2026-09-05，cordis_inspect 实测）

- `ctx.get('subagents')`：`start(name, SubagentStartRequest) → SubagentRun{id, localAgent, result, dispose()}`；`startContinuable / sendMessage / interrupt / listChildren / listDescendants / registerProvider / getProvider / list`。
- `SubagentStartRequest`：`{label?, prompt: ContentBlock[], parent: Agent, signal, agentOptions?: {provider?, model?, reasoningEffort?, maxTokens?}, outputSchema?: ObjectJsonSchema, maxDepth?, toolFilter?: {allow?, deny?}, persona?}`。
- `SubagentResult`：`{output: ContentBlock[], structured?, diagnostic?, stopReason: completed|aborted|error|max-tokens|refusal}`。
- `SubagentProvider`：`{name, capabilities: {agentOptions, outputSchema, depthLimit, toolFilter, persona}, inheritsParentContext, agentRouteDefaults?: {provider, model}, start(), prepareContinuable?()}`。
- `ctx.get('tools')`：`register / restrict({allow,deny}) / guard((exec) => string|undefined) / get / schemas / execute`；scoped 注册遮蔽全局，guard 可经 `agent.ctx` 按代理注册，返回字符串即拒绝。
- 事件：`tools/pre-execute`（waterfall allow/deny/ask）、`tools/post-execute`（replace/block）、`tools/execute`（around）、`tools/result`（emit）、`subagent/start`、`subagent/end`、`agent/request`（waterfall 替换 LlmCallConfig）。
- `fs/write-intent`、`fs/edit-intent`：单槽 waterfall，被官方 `dsh-fs-observation-policy` 占用——第三方守卫勿用（dsh-file-claim 实战经验）。
- `ctx.get('shell')`：`run(spec) → ShellRunResult`（门禁命令执行）。
- `ctx.get('tokenMeter')`：`measure(session)`（主/子成本分离）。
- `ctx.get('systemPrompt')`：`section(PromptSection)`（persona 自注册）。
- `ctx.get('skills')`：`register(SkillRegistration)`（预设作用域层，运行时注册 playbook）。
- `ctx.get('subagentModelSelection')`：`current()`（delegation 工具组合时读取的模型档位设置）。
- 动态工具注册（开发期）：`harness.registerTool(ctx, harness.defineTool({name, description, parameters, output: {schema, render}, execute}))`。
- 预设：`agentPresets.copy('standard', id, name)` → 编辑 `agent.cordis.yml` → `standingKeyFor(id)` mount-validate；用户根 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`。

## 附录 B：工具命名（避开现有工具）

| 本插件 | 现有同名风险 | 说明 |
| --- | --- | --- |
| `pilot_dispatch` | 无 | 契约派发（单任务） |
| `pilot_dispatch_batch` | 无 | 微需求聚合派发（P1） |
| `pilot_status` | 无 | 任务矩阵查询（P1） |
| `pilot_merge` | 无 | worktree 合并回收（P1） |

现有通用工具 `subagent` / `subagent_fork` / `workflow` / `ralph` 保持原样，与 pilot 系共存。
