// index.mjs — dsh-pilot 宿主面（唯一依赖 DSH 宿主服务的文件）
//
// 职责：注册契约工具 pilot_dispatch（schema 刻意无 code 字段）→ subagents.start
// 派发 → 结构化回执 → 门禁（shell 亲自执行 acceptance_cmd 取真实 exit code）→
// porcelain/哈希快照差集核验（git 优先，非 git 回落白名单哈希）→ verdict；
// tools.guard 按子代理 agent.id 拒白名单外写入（fail-open）；FAIL 重派新子代理
// （≤max_retries，耗尽 ESCALATED）；persona 一行 + playbook skill 按需载入（§2.3）。
// 失败大声：契约非法、provider 缺失、门禁异常都以 verdict+reason 显式返回。

import { relative, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import {
  RECEIPT_SCHEMA,
  validateContract,
  normalizeRelPath,
  pathAllowed,
  parsePorcelain,
  porcelainPaths,
  checkScope,
  checkReceipt,
  validateReceipt,
  extractReceiptJson,
  determineVerdict,
  escalate,
  buildChildPrompt,
  tailText,
  loadConfig,
  extractShellWriteTargets,
  fnv1aHex,
  snapshotChanged,
} from './pilot-core.mjs'

const WRITE_TOOLS = new Set(['write', 'edit', 'bash', 'pwsh'])

// persona 一行指针（DESIGN §2.3 pointer 档，目标 <80 token）
const PERSONA_LINE =
  '复杂编码任务：用 pilot_dispatch 起草契约派发子代理执行（含验收门禁），你只依据 verdict 推进，不亲手写业务代码；契约写法与 verdict 处理见 pilot-playbook 手册。'

const PLAYBOOK = `# pilot-playbook — 契约写作与裁决处理手册

## 何时派发，何时自己动手
- tier=fast（≤2 文件、文案/常量/单行修复）：允许主代理直接改，或聚合后一次派发。
- tier=standard（跨模块、核心状态、接口变更）：必须契约派发，主代理不写业务代码。
- 海量微需求：先聚合成一个 chore 契约（一份白名单、一条零回归门禁），一次派发。

## 契约四要素写法
1. goal：一句话（≤140 字），写"做什么"，不写"怎么做"。
2. detail：接口签名、边界条件、禁止事项。"合同定好后不许有自己的理解"的载体。
3. context：相关文件路径 + 接口摘要（如 "src/auth.ts: sign(uid): string"）。
   这是防幻觉关键——子代理零摸索，不需要"先摸清工程状况"。
4. allowed_files：最小充分集。宁可少了补契约，不要顺手撒大网。
5. acceptance_cmd：可判定命令（vitest/pytest/tsc/build）。禁止"写好测试"这类不可判定表述。

## tier 判定
- fast：小微改动。门禁降级为零回归（不填 acceptance_cmd），禁止新增测试，改动行数受限。
- standard：常规特性/修复。acceptance_cmd 必填，门禁真实执行。

## verdict 处理
- PASS：直接推进下一步，不要复核子代理的工作。
- FAIL：读 reason 与 error_tail（stderr 尾部，确定性内容）。修改契约（补 detail/context）
  或修正 acceptance_cmd 后重派；**不要原样重派**——同样输入只会得到同样失败。
- BLOCKED：读 summary。子代理判断契约有矛盾或缺少上下文——补 context 或拆小任务再派。
- ESCALATED：重试耗尽。升级给人类，或重写契约（通常是 acceptance_cmd 或范围错了）。

## 防幻觉纪律
- 只信插件返回的 verdict；子代理的 summary 仅供人读，不作为完成依据。
- exit code 以门禁执行为准，回执自报的 exit_code 仅作交叉校验。
- 回执虚报（files_changed 与实际 diff 不符）会被插件自动判 FAIL 并把真实 diff 喂回重试。`

// ---------- 仓库根解析（同 dsh-file-claim 的稳妥路径纪律） ----------

function agentId(agent) {
  return agent && typeof agent.id === 'string' ? agent.id : null
}

async function resolveRepoRoot(ctx, cwd) {
  const ws = ctx.get('workspaceRegistry')
  let root
  if (ws && typeof ws.resolveByPath === 'function') {
    try {
      const w = await ws.resolveByPath(cwd)
      if (w && typeof w.path === 'string') root = w.path
    } catch {
      // 解析失败回退 cwd，不阻断
    }
  }
  if (root === undefined) root = cwd
  if (typeof root !== 'string' || root === '') return null
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(root)) return null
  if (!existsSync(root)) return null
  return root
}

// ---------- shell 执行（门禁与 git 快照共用） ----------

async function runShell(ctx, repoRoot, command, signal, timeoutMs, sandboxMode) {
  const shell = ctx.get('shell')
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.run !== 'function') {
    throw new Error('shell 服务不可用：无法执行门禁/快照命令')
  }
  // sandboxMode 缺省不传（shell 按部署默认）；显式配置时沿用（DESIGN §10：门禁沿会话沙箱策略）
  const sandboxPolicy = sandboxMode ? { mode: sandboxMode, workspaceRoot: repoRoot } : undefined
  const spec = shell.resolve({ command, workdir: repoRoot, timeoutMs, signal, sandboxPolicy })
  const r = await shell.run(spec)
  return {
    exitCode: r.exitCode,
    timedOut: r.timedOut === true,
    stdout: r.stdout && typeof r.stdout.text === 'string' ? r.stdout.text : '',
    stderr: r.stderr && typeof r.stderr.text === 'string' ? r.stderr.text : '',
  }
}

// 任务前后 `git status --porcelain` 行差集（双向）：子代理期间新增/变化的行 +
// 消失的行（文件被改回/删除），映射为实际触碰的路径集合。
function changedPaths(beforeText, afterText) {
  const key = (l) => l.status + ' ' + l.path
  const before = parsePorcelain(beforeText)
  const after = parsePorcelain(afterText)
  const beforeKeys = new Set(before.map(key))
  const afterKeys = new Set(after.map(key))
  const changed = [...after.filter((l) => !beforeKeys.has(key(l))), ...before.filter((l) => !afterKeys.has(key(l)))]
  return porcelainPaths(changed)
}

// ---------- 非 git 工作区降级：白名单文件哈希快照（DESIGN §10） ----------
// 快照 = { rel: hash|null }，null 表示文件不存在或读取失败（失败大声记录）。
// 目录条目（以 / 结尾）暂不展开，仅静态记录（M1 限制，P1 listDir 游走补齐）；
// 目录下新建文件在降级模式检测不到。

// 单条目快照：readText 成功 → 内容哈希；抛错 → 视为不存在。
// 不用 stat——实测插件域里 stat 对已存在文件也可能返回 undefined（realm 视图差异），
// 而门禁 shell 与子代理写入都能看到同一文件；内容哈希才是降级快照唯一需要的事实。
async function snapshotEntry(fs, rel, repoRoot, signal) {
  const target = await fs.resolve(rel, { cwd: repoRoot })
  const text = await fs.readText(target, signal)
  return fnv1aHex(new TextEncoder().encode(String(text)))
}

function fileEntriesOf(allowedFiles) {
  return allowedFiles.filter((p) => !p.endsWith('/'))
}

async function snapshotWhitelist(ctx, repoRoot, allowedFiles, signal) {
  const fs = ctx.get('fs')
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') {
    throw new Error('fs 服务不可用：非 git 工作区无法做哈希快照')
  }
  const snapshot = {}
  for (const rel of fileEntriesOf(allowedFiles)) {
    try {
      snapshot[rel] = await snapshotEntry(fs, rel, repoRoot, signal)
    } catch (e) {
      if (signal && signal.aborted) throw e
      // 静默吞掉会让 after 快照误判"无变化"→ 回执被冤判虚报；大声记录
      console.error('[dsh-pilot] 白名单快照读取失败:', rel, e && e.message ? e.message : String(e))
      snapshot[rel] = null
    }
  }
  return snapshot
}

// ---------- 回执提取 ----------

function textOfOutput(output) {
  if (!Array.isArray(output)) return ''
  return output
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
}

function extractReceipt(result) {
  if (result && result.structured) {
    const v = validateReceipt(result.structured)
    if (v.ok) return v.receipt
  }
  // outputSchema 关闭（provider 不支持）或 structured 未过校验 → 自由文本兜底提取
  const text = textOfOutput(result && result.output)
  return extractReceiptJson(text)
}

// ---------- 守卫（同步；白名单与仓库根在派发时已缓存） ----------

function toRelWithin(repoRoot, target) {
  if (typeof target !== 'string' || target === '') return null
  if (isAbsolute(target)) {
    const rel = relative(repoRoot, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { escape: true }
    return { rel: normalizeRelPath(rel) }
  }
  return { rel: normalizeRelPath(target) }
}

function guardDenyReason(cfg, activeTasks, exec) {
  if (cfg.guard === false) return null
  const name = exec && exec.name
  if (!name || !WRITE_TOOLS.has(name)) return null
  const task = exec.agent && activeTasks.get(exec.agent.id)
  if (!task) return null // 非本插件派发的代理：不管
  const args = exec.arguments || {}
  let targets = []
  if (name === 'write' || name === 'edit') {
    targets = [args.file_path]
  } else {
    targets = extractShellWriteTargets(typeof args.command === 'string' ? args.command : '')
  }
  for (const t of targets) {
    const r = toRelWithin(task.repoRoot, t)
    if (!r) continue // 解析不出目标 → 放行（fail-open）
    if (r.escape) {
      return `dsh-pilot 守卫：路径 ${t} 越出任务工作区，拒绝写入。`
    }
    if (!pathAllowed(r.rel, task.allowedFiles)) {
      return (
        `dsh-pilot 守卫：路径 ${r.rel} 不在本任务白名单 [${task.allowedFiles.join(', ')}] 内，拒绝写入。` +
        `如确需修改，请主代理修改契约的 allowed_files 后重新派发。`
      )
    }
  }
  return null
}

// ---------- pilot_dispatch 主体 ----------

function toolParameters() {
  return {
    type: 'object',
    properties: {
      goal: { type: 'string', description: '一句话目标（≤140 字）' },
      detail: { type: 'string', description: '契约正文：需求细节、接口签名约定、边界条件、禁止事项' },
      context: {
        type: 'array',
        description: '相关文件路径 + 接口摘要（子代理零摸索，防幻觉）',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, note: { type: 'string' } },
          required: ['path'],
        },
      },
      allowed_files: { type: 'array', items: { type: 'string' }, description: '修改白名单（相对路径；目录项以 / 结尾或直接写目录）' },
      acceptance_cmd: { type: 'string', description: '客观验收命令（tier=standard 必填；由插件亲自执行取 exit code）' },
      tier: { type: 'string', enum: ['fast', 'standard'], description: 'fast=小微改动零回归；standard=契约门禁（默认）' },
      max_retries: { type: 'integer', description: '失败重试上限（默认 2，0..5）' },
    },
    required: ['goal', 'detail', 'allowed_files'],
  }
}

const VERDICT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['PASS', 'FAIL', 'BLOCKED', 'ESCALATED'] },
    reason: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    gate: {
      type: 'object',
      properties: { cmd: { type: 'string' }, exit_code: { type: 'integer' } },
    },
    attempts: { type: 'integer' },
    child: { type: 'object', properties: { model: { type: 'string' } } },
    error_tail: { type: 'string' },
  },
  required: ['verdict', 'files_changed', 'attempts'],
}

function renderVerdict(_args, value) {
  const lines = [`verdict: ${value.verdict}`]
  if (value.reason) lines.push(`reason: ${value.reason}`)
  if (Array.isArray(value.files_changed) && value.files_changed.length > 0) {
    lines.push('files: ' + value.files_changed.slice(0, 10).join(', ') + (value.files_changed.length > 10 ? ` 等 ${value.files_changed.length} 个` : ''))
  }
  if (value.gate) lines.push(`gate: ${value.gate.cmd} → exit ${value.gate.exit_code}`)
  lines.push(`attempts: ${value.attempts}${value.child && value.child.model ? ` (child model: ${value.child.model})` : ''}`)
  if (value.verdict === 'FAIL' || value.verdict === 'ESCALATED') {
    if (value.error_tail) lines.push('error_tail:\n' + value.error_tail)
    lines.push('处理：修改契约（detail/context/acceptance_cmd）后重新 pilot_dispatch；勿原样重派。')
  }
  if (value.verdict === 'BLOCKED') lines.push('处理：读 reason/summary，补上下文或拆小任务后再派。')
  return [{ type: 'text', text: lines.join('\n') }]
}

function feedbackOf(parts, maxChars) {
  const s = parts.filter(Boolean).join('\n')
  return s ? tailText(s, maxChars) : ''
}

async function dispatchOnce(ctx, cfg, contract, { repoRoot, parent, signal, feedback, attempt }) {
  const subagents = ctx.get('subagents')
  if (!subagents || typeof subagents.start !== 'function') {
    throw new Error('subagents 服务不可用：无法派发子代理')
  }
  const provider = subagents.getProvider ? subagents.getProvider(cfg.provider) : undefined
  if (!provider) {
    const known = subagents.list ? subagents.list().join(', ') : '(未知)'
    throw new Error(`子代理 provider "${cfg.provider}" 不存在。可用：${known}`)
  }
  const hasOutputSchema = !(provider.capabilities && provider.capabilities.outputSchema === false)
  const prompt = buildChildPrompt(contract, feedback)
  const run = await subagents.start(cfg.provider, {
    label: `pilot#${attempt}:${contract.goal.slice(0, 24)}`,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
    // 深度语义：子代理自身占 depth 1（实测：0 会拒绝派发本身），1 = 允许子代、拒绝孙代
    maxDepth: 1,
    ...(cfg.model ? { agentOptions: { model: cfg.model } } : {}),
    ...(hasOutputSchema ? { outputSchema: RECEIPT_SCHEMA } : {}),
    persona: '你是执行手，只做契约内的事；完成后仅返回回执 JSON。',
  })
  return run
}

async function executeDispatch(ctx, cfg, activeTasks, args, exec) {
  if (!agentId(exec.agent)) return { verdict: 'FAIL', reason: '无法确定会话身份：缺少 agent', files_changed: [], attempts: 0 }

  const cwd = exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : undefined
  const repoRoot = cwd ? await resolveRepoRoot(ctx, cwd) : null
  if (!repoRoot) return { verdict: 'FAIL', reason: '无法解析工作区根：缺少会话 cwd 或路径不可用', files_changed: [], attempts: 0 }

  const v = validateContract(args)
  if (!v.ok) {
    return { verdict: 'FAIL', reason: '契约非法：' + v.errors.join('；'), files_changed: [], attempts: 0 }
  }
  const contract = v.contract
  // 契约显式给了 max_retries 用契约的；否则回落插件级配置（cordis.patch.yml config.maxRetries）
  const maxRetries =
    args && args.max_retries !== undefined && args.max_retries !== null ? contract.max_retries : cfg.maxRetries

  // 核验基线：git 可用走 porcelain 差集；非 git 回落白名单哈希快照（§10 降级）
  let useGit = true
  let beforeText = ''
  let beforeSnapshot = null
  try {
    const g = await runShell(ctx, repoRoot, 'git status --porcelain', exec.signal, cfg.gateTimeoutMs, cfg.sandboxMode)
    if (g.exitCode !== 0) useGit = false
    else beforeText = g.stdout
  } catch {
    useGit = false
  }
  if (!useGit) {
    try {
      beforeSnapshot = await snapshotWhitelist(ctx, repoRoot, contract.allowed_files, exec.signal)
    } catch (e) {
      return { verdict: 'FAIL', reason: '非 git 工作区且哈希快照不可用：' + (e && e.message ? e.message : String(e)), files_changed: [], attempts: 0 }
    }
  }

  let attempts = 0
  let feedback = ''
  let last = null
  let lastActual = [] // 最近一轮实际触碰路径（进入 out.files_changed）
  let lastGate = null // 最近一轮门禁结果（进入 out.gate）
  let lastTail = '' // 最近一轮确定性错误尾部（进入 out.error_tail）
  let lastSnapshotDiag = null // 降级模式诊断：before/after 快照（truth 失败时附入 reason）
  for (;;) {
    attempts += 1
    let run
    try {
      run = await dispatchOnce(ctx, cfg, contract, { repoRoot, parent: exec.agent, signal: exec.signal, feedback, attempt: attempts })
    } catch (e) {
      last = { verdict: 'FAIL', retryable: false, reason: '派发子代理失败：' + (e && e.message ? e.message : String(e)) }
      break
    }
    // 子代理白名单登记（守卫按 agent.id 查这张表；start 返回即登记，竞态窗口极小）
    const childId = run.localAgent && run.localAgent.id ? run.localAgent.id : run.id
    activeTasks.set(childId, { allowedFiles: contract.allowed_files, repoRoot })
    let result
    try {
      result = await run.result
    } catch (e) {
      // 会话被用户中止（exec.signal aborted）不应触发重试环：视为 BLOCKED
      result = exec.signal && exec.signal.aborted ? { stopReason: 'aborted', output: [] } : { stopReason: 'error', output: [], diagnostic: e && e.message ? e.message : String(e) }
    } finally {
      activeTasks.delete(childId)
      if (run && typeof run.dispose === 'function') {
        try {
          run.dispose()
        } catch {
          // dispose 失败不影响裁决
        }
      }
    }

    const receipt = extractReceipt(result)
    let actualPaths
    if (useGit) {
      let afterText
      try {
        afterText = (await runShell(ctx, repoRoot, 'git status --porcelain', exec.signal, cfg.gateTimeoutMs, cfg.sandboxMode)).stdout
      } catch {
        afterText = beforeText
      }
      actualPaths = changedPaths(beforeText, afterText)
    } else {
      let afterSnapshot
      try {
        afterSnapshot = await snapshotWhitelist(ctx, repoRoot, contract.allowed_files, exec.signal)
      } catch {
        afterSnapshot = beforeSnapshot
      }
      actualPaths = snapshotChanged(beforeSnapshot, afterSnapshot)
      lastSnapshotDiag = { before: beforeSnapshot, after: afterSnapshot }
    }
    const scope = checkScope(actualPaths, contract.allowed_files)
    const truth = receipt ? checkReceipt(receipt, actualPaths) : { truthful: true, claimedNotChanged: [], changedNotClaimed: [] }

    let gate = null
    let gateTail = ''
    if (contract.acceptance_cmd) {
      try {
        const g = await runShell(ctx, repoRoot, contract.acceptance_cmd, exec.signal, cfg.gateTimeoutMs, cfg.sandboxMode)
        gate = { cmd: contract.acceptance_cmd, exitCode: g.exitCode === null ? -1 : g.exitCode, timedOut: g.timedOut }
        gateTail = tailText(g.stderr || g.stdout, 1200)
      } catch (e) {
        gate = { cmd: contract.acceptance_cmd, exitCode: -1, timedOut: false }
        gateTail = '门禁命令执行异常：' + (e && e.message ? e.message : String(e))
      }
    }

    const dv = determineVerdict({
      childStopReason: result ? result.stopReason : 'error',
      receipt,
      scope,
      truth,
      gate,
    })
    last = dv
    lastActual = actualPaths
    lastGate = gate
    lastTail =
      gate && (gate.exitCode !== 0 || gate.timedOut)
        ? gateTail
        : result && result.diagnostic
          ? tailText(String(result.diagnostic), 800)
          : ''
    if (dv.retryable && attempts <= maxRetries) {
      feedback = feedbackOf(
        [
          gate && (gate.exitCode !== 0 || gate.timedOut) ? `验收命令失败（exit ${gate.exitCode}${gate.timedOut ? ', 超时' : ''}）：\n${gateTail}` : '',
          receipt ? '' : '未检测到有效回执 JSON：完成后必须仅返回契约要求的回执 JSON，不要输出其他散文。',
          result && result.diagnostic ? `子代理诊断：${tailText(String(result.diagnostic), 600)}` : '',
          scope.ok ? '' : `越界修改（白名单外）：${scope.violations.join('、')}`,
          truth.truthful ? '' : `回执虚报：声称改了但没改 ${truth.claimedNotChanged.join('、') || '无'}；实际改了但没报 ${truth.changedNotClaimed.join('、') || '无'}`,
        ],
        cfg.feedbackMaxChars,
      )
      continue
    }
    break
  }

  const final = last.retryable ? escalate(last) : last
  const out = {
    verdict: final.verdict,
    files_changed: lastActual,
    attempts,
    child: { model: cfg.model || '(provider 默认)' },
  }
  if (final.reason) out.reason = final.reason
  // 降级模式诊断：truth 失败时把快照带进 reason，主代理/人类可直接看到 before/after 哈希
  if (lastSnapshotDiag && lastActual.length === 0 && final.reason && final.reason.includes('回执虚报')) {
    out.reason += '；快照诊断 before=' + JSON.stringify(lastSnapshotDiag.before) + ' after=' + JSON.stringify(lastSnapshotDiag.after)
  }
  if (lastGate) out.gate = { cmd: lastGate.cmd, exit_code: lastGate.exitCode }
  if ((final.verdict === 'FAIL' || final.verdict === 'ESCALATED') && lastTail) out.error_tail = lastTail
  return out
}

// ---------- 插件入口 ----------

export default {
  name: 'dsh-pilot',
  inject: ['tools'],
  apply(ctx, config = {}) {
    const cfg = loadConfig(config)
    const activeTasks = new Map() // childAgentId → { allowedFiles, repoRoot }

    // 1. 契约工具（P0 只注册这一个工具——上下文零常驻纪律）
    ctx.effect(() =>
      ctx.tools.register({
        name: 'pilot_dispatch',
        description: '契约派发：把编码任务契约交给廉价子代理执行，插件亲自跑验收命令与 diff 白名单核验，返回 PASS/FAIL/BLOCKED/ESCALATED 裁决。你只看裁决，不亲手写业务代码。',
        parameters: toolParameters(),
        output: { schema: VERDICT_OUTPUT_SCHEMA, render: renderVerdict },
        async execute(args, exec) {
          try {
            return await executeDispatch(ctx, cfg, activeTasks, args, exec)
          } catch (e) {
            return { verdict: 'FAIL', reason: 'pilot 内部错误：' + (e && e.message ? e.message : String(e)), files_changed: [], attempts: 0 }
          }
        },
      }),
    )

    // 2. 白名单守卫（同步；fail-open 边界与 dsh-file-claim 同一哲学）
    ctx.effect(() =>
      ctx.tools.guard((exec) => {
        try {
          return guardDenyReason(cfg, activeTasks, exec)
        } catch {
          // 守卫自身出错 → 放行，不阻断宿主工具面
          return null
        }
      }),
    )

    // 3. persona 一行指针（exposure:'silent' 时不注入）
    if (cfg.exposure !== 'silent') {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        ctx.effect(() => systemPrompt.section({ name: 'dsh-pilot-protocol', order: 120, text: PERSONA_LINE }))
      }
    }

    // 4. playbook skill（按需载入；silent 档对模型不可见，仅用户显式调用）
    const skills = ctx.get('skills')
    if (skills && typeof skills.register === 'function') {
      ctx.effect(() =>
        skills.register({
          name: 'pilot-playbook',
          description: 'dsh-pilot 契约写作与裁决处理手册：契约四要素、tier 判定、verdict 失败处理、防幻觉纪律',
          whenToUse: '起草 pilot_dispatch 契约前，或需要处理 FAIL/BLOCKED/ESCALATED 裁决时',
          source: 'runtime',
          invocation: { modelInvocable: cfg.exposure !== 'silent', userInvocable: true },
          content: PLAYBOOK,
        }),
      )
    }
  },
}
