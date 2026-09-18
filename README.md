# dsh-pilot

**Contract-driven master/subagent dispatch for DeepSeek Harness (DSH).** The master (expensive model) drafts a *contract*, cheap subagents execute it, and the plugin adjudicates **deterministically** — acceptance-command exit codes, git-diff whitelist, receipt cross-check — so the master only reads a compact verdict.

> 状态：**M1.5 完成**（DESIGN 定稿见 [DESIGN.md](./DESIGN.md)；实测反馈修正 F21–F24 见其 §5.4/§9.2；开源生态对照与定位见其 §11）。
> 一句话定位：**agent-teams 给你一支团队，dsh-pilot 给你一份合同。**

## Why

廉价模型（如 DeepSeek v4.1 flash）写码又快又便宜，但幻觉重、不擅长规划与理解工程状况。dsh-pilot 把"规划 + 仲裁"留给贵模型，把"执行"交给廉价子代理，中间用**代码裁决**替代 LLM 互评：

- 契约 schema **刻意没有 code 字段** —— 主代理物理上递不了代码；
- 门禁 exit code 由**插件亲自执行**验收命令取得，不信回执自报；
- `git status` 任务前后快照差集 vs 回执 `files_changed` 交叉核验，**虚报即 FAIL 并把真实 diff 喂回重试**；
- 白名单守卫：子代理对 `allowed_files` 之外的写入被直接拒绝（`tools.guard`，同步、fail-open）；
- 失败重试只喂确定性内容（stderr 尾部、越界清单），耗尽 → `ESCALATED` 上交人类。

## Install

```sh
dsh plugin --profile web add dsh-pilot        # npm 发布后
dsh plugin --profile web add -w link:D:\Build\dsh-pilot   # 本地开发
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

## License

MIT
