# dsh-pilot

**Contract-driven master/subagent dispatch for DeepSeek Harness (DSH).** The master (expensive model) drafts a *contract*, cheap subagents execute it, and the plugin adjudicates **deterministically** — acceptance-command exit codes, git-diff whitelist, receipt cross-check — so the master only reads a compact verdict.

> 一句话定位：**agent-teams 给你一支团队，dsh-pilot 给你一份合同。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**状态：M1.6 完成，全链路可用** —— 契约派发 → 白名单守卫 → 门禁执行 → 裁决回传，62/62 自动化测试通过，并经真实子代理派发会话验收（PASS）。设计定稿、里程碑与真实验收记录见 [DESIGN.md](./DESIGN.md)，开源生态对照与差异化定位见其 §11。

## Why

廉价模型（如 DeepSeek v4.1 flash）写码又快又便宜，但幻觉重、不擅长规划与理解工程状况。dsh-pilot 把"规划 + 仲裁"留给贵模型，把"执行"交给廉价子代理，中间用**代码裁决**替代 LLM 互评：

- 契约 schema **刻意没有 code 字段** —— 主代理物理上递不了代码；
- 门禁 exit code 由**插件亲自执行**验收命令取得，不信回执自报；
- `git status` 任务前后快照差集 vs 回执 `files_changed` 交叉核验，**虚报即 FAIL 并把真实 diff 喂回重试**；
- 白名单守卫：子代理对 `allowed_files` 之外的写入被直接拒绝（`tools.guard`，同步、fail-open）；
- 失败重试只喂确定性内容（stderr 尾部、越界清单），耗尽 → `ESCALATED` 上交人类。

## How it works

```
 主代理（旗舰模型）                    dsh-pilot 插件（Host，纯代码裁决）
 ─────────────────                    ──────────────────────────────
 理解需求 · 摸清工程状况                ① 组装子代理 prompt = 契约 + 内联上下文
 起草契约 · 不亲手写代码     ──契约──▶   ② subagents.start(outputSchema, toolFilter)
                                      ③ 文件白名单守卫（tools.guard）
        ▲                             ④ 门禁：shell 跑 acceptance_cmd → 真实 exit code
        └────── verdict ◀──────────   ⑤ 核验：git diff vs 白名单 & 回执真实性
        （紧凑 JSON，<200 token）       ⑥ 失败：确定性反馈重试（≤max_retries）
```

契约示例（`pilot_dispatch` 入参，schema 强校验）：

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

裁决示例（插件 → 主代理，主代理**只看这个**）：

```json
{
  "verdict": "PASS",
  "files_changed": ["src/auth.ts", "tests/auth.test.ts"],
  "gate": { "cmd": "pnpm vitest run tests/auth.test.ts", "exit_code": 0 },
  "attempts": 1,
  "child": { "model": "deepseek-v4.1-flash", "tokens": 12345 }
}
```

`verdict ∈ { PASS, FAIL, BLOCKED, ESCALATED }`：FAIL 附截断 stderr（确定性内容）；BLOCKED 区分基础设施失败与契约失败（前者修环境原样重派，后者改契约）；ESCALATED 表示重试耗尽、上交人类。非 PASS 裁决另附 `workspace_delta` 现场增量摘要——半成品留在工作区，先验收或回滚再派新契约。

## Install

尚未发布 npm。开发期本地挂载：

```sh
dsh plugin --profile web add -w link:D:\Build\dsh-pilot   # 本地开发
dsh plugin --profile web add dsh-pilot                    # npm 发布后
```

## Config（cordis.patch.yml 组合行）

```yaml
- insert:
    - id: dsh-pilot
      name: dsh-pilot
      config:
        provider: spawn              # 子代理 provider（subagents.list() 可查）
        model: deepseek-v4.1-flash   # 钉死子代理模型
        exposure: pointer            # pointer=一行 persona 指针；silent=上下文零占用
        guard: true
        maxRetries: 2
        gateTimeoutMs: 300000
        feedbackMaxChars: 2000
```

上下文零常驻纪律（DESIGN §2.3）：P0 只注册 `pilot_dispatch` 一个工具；详细手册在 `pilot-playbook` skill 里按需载入；`exposure: silent` 时 persona 段不注入、skill 仅用户显式调用。

## Docs

- [DESIGN.md](./DESIGN.md) — 设计定稿：契约/回执/裁决规格、幻觉防御五件套（§6.2）、成本分层（§6.3）、风险表（§10）、开源生态对照（§11）
- 测试：`npm test`（pilot-core 纯函数单测 + mock-ctx 集成测试，node --test）

## Ecosystem

DSH 插件生态同作者作品：[dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)（25+ 外部 Agent 会话迁移导入）· [dsh-file-claim](https://github.com/Nwflower/dsh-file-claim)（多会话文件认领）· [dsh-perf-lens](https://github.com/Nwflower/dsh-perf-lens)（插件开销面板）· [dsh-claude-style](https://github.com/Nwflower/dsh-claude-style)

## License

MIT
