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
  extractGatePaths,
  classifyInfra,
  isCommandNotFoundExit,
  parseShortstat,
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

## 契约五要素写法
1. goal：一句话（≤140 字），写"做什么"，不写"怎么做"。
2. detail：接口签名、边界条件、禁止事项。"合同定好后不许有自己的理解"的载体。
3. context：相关文件路径 + 接口摘要（如 "src/auth.ts: sign(uid): string"）。
   这是防幻觉关键——子代理零摸索，不需要"先摸清工程状况"。
4. allowed_files：最小充分集。宁可少了补契约，不要顺手撒大网。
5. acceptance_cmd：可判定命令（vitest/pytest/tsc/build）。禁止"写好测试"这类不可判定表述。

## 门禁设计模式（实战踩坑总结）
- 门禁范围必须与白名单对齐。acceptance_cmd 在仓库根执行：若它扫描全仓而正则命中
  白名单外的既有内容，子代理会陷入"通过必须改、契约禁止改"的死锁。插件会检测这种情况：
  门禁命中全部落在白名单外 → 直接 BLOCKED 免重试；部分越界 → 重试反馈中点名提醒。
  预防写法：把路径参数写进门禁命令，只扫白名单——
  pytest 指定测试文件（不是裸 pytest）；Select-String 用 -Path 指定范围；eslint/tsc 指定目标。
- Windows 陷阱：Select-String 默认大小写不敏感，会命中 p11.3 这类大小写变体——
  需要区分时加 -CaseSensitive；正则里的路径分隔符要同时兼容正斜杠与反斜杠。
- 门禁只断言"白名单内改动引入的内容"，不要用它复检整个仓库的历史遗留。
- 仓库基线可能本来就脏（既有失败/告警）时，契约加 baseline_gate: true：
  插件派发前先自检门禁，基线不绿则不派发，直接 BLOCKED 并附基线输出与越界命中分析，
  省一次子代理成本。门禁开销大（全量测试）时按需开启。

## 基础设施失败与契约失败分开处理
- verdict 带 error_class 字段：infrastructure=环境/配置问题；contract=契约/门禁/核验问题。
- 子代理报 SetNamedSecurityInfoW (Win32 5)、沙箱 ACL 拒绝、命令找不到（exit 127/9009）→
  属于基础设施失败，插件不重试。处置：修环境或在插件组合里调 sandboxMode（Windows
  ACL runner 异常时用 danger-full-access），然后原样重派——契约本身没有问题，不要改契约。
- BLOCKED 时附带 workspace_delta（工作区增量：文件数/行数/未跟踪数）。失败的 attempt
  半成品仍留在工作区：派新契约前先验收或回滚现场，避免重复劳动。

## verdict 处理
- PASS：直接推进下一步，不要复核子代理的工作。
- FAIL：读 reason 与 error_tail（stderr 尾部，确定性内容）。修改契约（补 detail/context）
  或修正 acceptance_cmd 后重派；不要原样重派——同样输入只会得到同样失败。
- BLOCKED：读 reason 与 error_class。两种来源分开处理：
  - contract：子代理/门禁判定契约矛盾或缺上下文 → 补 context、扩白名单或收窄门禁后重派；
  - infrastructure：修环境后原样重派。
  - 先看 workspace_delta 决定保留还是回滚现场，再派新契约。
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

// tools.guard 返回契约（实测自 dsh-tools guardReason，M1.6 崩溃根因）：
// undefined = 放行；任何非 undefined 值（包括 null！）都被当作拒绝理由并拒绝整个工具调用。
// 全部放行路径必须 return undefined——null 会让"所有工具调用"全部被拒（曾导致全工具返回 null）。
function guardDenyReason(cfg, activeTasks, exec) {
  if (cfg.guard === false) return undefined
  const name = exec && exec.name
  if (!name || !WRITE_TOOLS.has(name)) return undefined
  const task = exec.agent && activeTasks.get(exec.agent.id)
  if (!task) return undefined // 非本插件派发的代理：不管（fail-open）
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
  return undefined
}

// ---------- 门禁越界命中分类（M1.5：门禁范围 × 白名单对齐） ----------

// 依赖目录噪声（堆栈/构建产物引用）不参与越界命中统计——误报会把正常门禁失败
// 冤判成结构性死锁；漏报只是回落普通重试环，代价更小，所以偏保守。
const DEP_DIR = /(^|\/)(node_modules|venv|\.venv|site-packages|dist|build|coverage|\.git)\//
const MAX_GATE_HITS = 10

async function pathExistsInRepo(fs, repoRoot, rel) {
  // fs 不可用时无法证伪：宁可计为命中（fail 到死锁检测），BLOCKED reason 会列清单供裁决方甄别
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') return true
  try {
    await fs.readText(await fs.resolve(rel, { cwd: repoRoot }))
    return true
  } catch {
    return false
  }
}

// 门禁输出 → { inScope, outOfScope }：相对路径直接核验；绝对路径还原为仓库相对；
// 白名单外候选须真实存在（readText 可读）才计为命中，防堆栈/文档噪声误判。
async function classifyGatePaths(ctx, repoRoot, gateText, allowedFiles) {
  const inScope = []
  const outOfScope = []
  for (const raw of extractGatePaths(gateText)) {
    if (DEP_DIR.test('/' + raw)) continue
    let rel = raw
    if (isAbsolute(raw)) {
      const r = relative(repoRoot, raw)
      if (r === '' || r.startsWith('..') || isAbsolute(r)) continue // 仓库外引用：忽略
      rel = normalizeRelPath(r)
    }
    if (rel.startsWith('../')) continue
    if (pathAllowed(rel, allowedFiles)) {
      if (!inScope.includes(rel)) inScope.push(rel)
      continue
    }
    if (outOfScope.length >= MAX_GATE_HITS) continue
    if (!outOfScope.includes(rel) && (await pathExistsInRepo(ctx.get('fs'), repoRoot, rel))) outOfScope.push(rel)
  }
  return { inScope, outOfScope }
}

// ---------- 现场增量摘要（M1.5：非 PASS 裁决让裁决方一眼看清半成品规模） ----------

// 未跟踪文件计数：after porcelain 中 status=?? 且 before 里没有的同名条目。
function untrackedCount(afterText, beforeText) {
  const before = new Set(parsePorcelain(beforeText).map((l) => l.status + ' ' + l.path))
  return parsePorcelain(afterText).filter((l) => l.status === '??' && !before.has('?? ' + l.path)).length
}

// 摘要失败绝不影响裁决本身：调用方兜 try/catch。
async function collectWorkspaceDelta(ctx, repoRoot, useGit, exec, cfg, beforeText, lastAfterGitText, lastActual) {
  if (!useGit) {
    // 降级快照只有文件级事实（白名单触碰数），行数拿不到
    return { files: lastActual.length }
  }
  let short = null
  try {
    short = parseShortstat((await runShell(ctx, repoRoot, 'git diff HEAD --shortstat', exec.signal, cfg.gateTimeoutMs, cfg.sandboxMode)).stdout)
  } catch {
    short = null
  }
  // shortstat 解析失败（如空仓库无 HEAD）回落 porcelain 触碰数
  const delta = short
    ? { files: short.files, insertions: short.insertions, deletions: short.deletions }
    : { files: lastActual.length }
  delta.untracked = untrackedCount(lastAfterGitText, beforeText)
  return delta
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
      baseline_gate: { type: 'boolean', description: '派发前先自检 acceptance_cmd：基线 exit≠0 则不派发直接 BLOCKED（附越界命中分析）。仓库基线可能本来就不绿时开启' },
    },
    required: ['goal', 'detail', 'allowed_files'],
  }
}

const VERDICT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    // 静态 tools.register 走 dsh-tools 的 JSON Schema 子集校验（assertSupportedJsonSchema）：
    // 约束关键字（enum/const/properties/items…）所在节点必须显式声明 type 或 oneOf——
    // enum 缺 type 会让整个插件树装载失败（M1 挂载崩溃根因，见 test/schema-subset.test.mjs）
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED', 'ESCALATED'] },
    reason: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    gate: {
      type: 'object',
      properties: { cmd: { type: 'string' }, exit_code: { type: 'integer' } },
    },
    attempts: { type: 'integer' },
    child: { type: 'object', properties: { model: { type: 'string' } } },
    error_tail: { type: 'string' },
    error_class: { type: 'string', enum: ['infrastructure', 'contract', 'unknown'] },
    gate_out_of_scope: { type: 'array', items: { type: 'string' } },
    workspace_delta: {
      type: 'object',
      properties: {
        files: { type: 'integer' },
        insertions: { type: 'integer' },
        deletions: { type: 'integer' },
        untracked: { type: 'integer' },
      },
    },
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
  if (value.error_class) lines.push(`error_class: ${value.error_class}`)
  if (Array.isArray(value.gate_out_of_scope) && value.gate_out_of_scope.length > 0) {
    lines.push('gate_out_of_scope: ' + value.gate_out_of_scope.slice(0, 8).join(', '))
  }
  if (value.workspace_delta) {
    const d = value.workspace_delta
    const parts = []
    if (typeof d.files === 'number' && d.files > 0) parts.push(d.files + ' files')
    if (typeof d.insertions === 'number' && d.insertions > 0) parts.push('+' + d.insertions)
    if (typeof d.deletions === 'number' && d.deletions > 0) parts.push('-' + d.deletions)
    if (typeof d.untracked === 'number' && d.untracked > 0) parts.push(d.untracked + ' untracked')
    if (parts.length > 0) lines.push('workspace_delta: ' + parts.join(', '))
  }
  lines.push(`attempts: ${value.attempts}${value.child && value.child.model ? ` (child model: ${value.child.model})` : ''}`)
  const infraHint = value.error_class === 'infrastructure'
  if (value.verdict === 'FAIL' || value.verdict === 'ESCALATED') {
    if (value.error_tail) lines.push('error_tail:\n' + value.error_tail)
    lines.push(
      infraHint
        ? '处理：基础设施/环境问题——修复环境后原样重派，契约无需修改。'
        : '处理：修改契约（detail/context/acceptance_cmd）后重新 pilot_dispatch；勿原样重派。',
    )
  }
  if (value.verdict === 'BLOCKED') {
    lines.push(
      infraHint
        ? '处理：基础设施/环境问题——修复环境后原样重派，契约无需修改。'
        : '处理：读 reason 裁决方向；先看 workspace_delta 决定保留或回滚现场，再派新契约。',
    )
  }
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

  // baseline_gate 自检（契约显式优先，插件级 config.baselineGate 兜底）：门禁基线不绿
  // 则不派发子代理，直接 BLOCKED——脏基线下重试纯属浪费；附越界命中分析供裁决。
  const baselineEnabled = contract.baseline_gate !== undefined ? contract.baseline_gate : cfg.baselineGate === true
  if (baselineEnabled && contract.acceptance_cmd) {
    let base = null
    let baseRunnerError = null
    try {
      base = await runShell(ctx, repoRoot, contract.acceptance_cmd, exec.signal, cfg.gateTimeoutMs, cfg.sandboxMode)
    } catch (e) {
      baseRunnerError = e && e.message ? e.message : String(e)
    }
    if (!base || base.exitCode !== 0 || base.timedOut) {
      const exitCode = base ? (base.exitCode === null ? -1 : base.exitCode) : -1
      const out = {
        verdict: 'BLOCKED',
        files_changed: [],
        attempts: 0,
        gate: { cmd: contract.acceptance_cmd, exit_code: exitCode },
        error_class: baseRunnerError || isCommandNotFoundExit(exitCode) ? 'infrastructure' : 'contract',
        reason:
          'baseline_gate 自检：门禁在派发前即失败（exit ' + exitCode + (base && base.timedOut ? '，超时' : '') +
          '），失败非本次改动引入，未派发子代理。' +
          (baseRunnerError ? '门禁执行异常：' + baseRunnerError + '。修复环境后重派。' : '请先修复既有失败或修正门禁，再重派。'),
      }
      if (base) {
        const hits = await classifyGatePaths(ctx, repoRoot, (base.stdout || '') + '\n' + (base.stderr || ''), contract.allowed_files)
        if (hits.outOfScope.length > 0) {
          out.gate_out_of_scope = hits.outOfScope
          out.reason += '门禁命中白名单外既有文件：' + hits.outOfScope.join('、') + '——收窄门禁范围（限定路径参数）或扩 allowed_files 后重派。'
        }
      }
      return out
    }
  }

  let attempts = 0
  let feedback = ''
  let last = null
  let lastActual = [] // 最近一轮实际触碰路径（进入 out.files_changed）
  let lastGate = null // 最近一轮门禁结果（进入 out.gate）
  let lastTail = '' // 最近一轮确定性错误尾部（进入 out.error_tail）
  let lastSnapshotDiag = null // 降级模式诊断：before/after 快照（truth 失败时附入 reason）
  let lastGateScope = null // 最近一轮门禁越界命中分类（进 out.gate_out_of_scope 与 reason 裁决提示）
  let lastAfterGitText = '' // 最近一轮 after porcelain（现场增量 untracked 计数用）
  for (;;) {
    attempts += 1
    let run
    try {
      run = await dispatchOnce(ctx, cfg, contract, { repoRoot, parent: exec.agent, signal: exec.signal, feedback, attempt: attempts })
    } catch (e) {
      // 契约在派发前已过校验：到这一步的失败都是基础设施/配置问题，重试子代理无意义
      last = {
        verdict: 'BLOCKED',
        retryable: false,
        cause: 'dispatch',
        error_class: 'infrastructure',
        reason:
          '派发子代理失败（基础设施/配置）：' + (e && e.message ? e.message : String(e)) +
          '。修复环境或配置后原样重派，契约无需修改。',
      }
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
      lastAfterGitText = afterText
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
    let gateText = ''
    let gateRunnerError = null
    if (contract.acceptance_cmd) {
      try {
        const g = await runShell(ctx, repoRoot, contract.acceptance_cmd, exec.signal, cfg.gateTimeoutMs, cfg.sandboxMode)
        gate = { cmd: contract.acceptance_cmd, exitCode: g.exitCode === null ? -1 : g.exitCode, timedOut: g.timedOut }
        gateText = (g.stdout || '') + '\n' + (g.stderr || '')
        gateTail = tailText(g.stderr || g.stdout, 1200)
      } catch (e) {
        gateRunnerError = e && e.message ? e.message : String(e)
        gate = { cmd: contract.acceptance_cmd, exitCode: -1, timedOut: false }
        gateTail = '门禁命令执行异常：' + gateRunnerError
      }
    }
    // 越界命中分类：只在门禁真实执行且失败时做（runner 异常没有门禁输出可言）
    let gateScope = null
    if (gate && (gate.exitCode !== 0 || gate.timedOut) && gateRunnerError === null) {
      gateScope = await classifyGatePaths(ctx, repoRoot, gateText, contract.allowed_files)
    }

    let dv = determineVerdict({
      childStopReason: result ? result.stopReason : 'error',
      receipt,
      scope,
      truth,
      gate,
    })
    // 基础设施失败分流（M1.5 反馈）：沙箱 ACL/缺二进制等持久性环境问题重试无意义，
    // 直接 BLOCKED 并点名"修环境原样重派"——避免把环境问题误判为任务不可行
    if (dv.cause === 'child-error' && result && result.diagnostic && classifyInfra(String(result.diagnostic))) {
      dv = {
        verdict: 'BLOCKED',
        retryable: false,
        cause: 'child-infra',
        error_class: 'infrastructure',
        reason:
          '基础设施失败（子代理执行错误）：' + tailText(String(result.diagnostic), 300) +
          '。修复环境或调整 sandboxMode 后原样重派，契约无需修改。',
      }
    } else if (dv.cause === 'gate' && (gateRunnerError !== null || isCommandNotFoundExit(gate.exitCode))) {
      dv = {
        verdict: 'BLOCKED',
        retryable: false,
        cause: 'gate-infra',
        error_class: 'infrastructure',
        reason:
          gateRunnerError !== null
            ? '门禁无法执行（基础设施）：' + gateRunnerError + '。修复环境或调整 sandboxMode 后重派。'
            : '门禁命令找不到（exit ' + gate.exitCode + '）：二进制不在 PATH 或命令名写错。修复环境或修正 acceptance_cmd 后重派。',
      }
    }
    // 注意不做硬短路：门禁输出点名白名单外文件≠"必须改它"（失败测试天然打印测试文件名）。
    // 环内只注记（反馈+输出），确定性死锁判定交给 baseline_gate 派发前自检；耗尽后 reason 附裁决提示。
    last = dv
    lastActual = actualPaths
    lastGate = gate
    lastGateScope = gateScope
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
          gateScope && gateScope.outOfScope.length > 0
            ? `门禁输出涉及白名单外文件（${gateScope.outOfScope.join('、')}）：这些不在你的白名单内，禁止修改；失败可能由白名单外既有内容触发——只修复白名单内的问题。`
            : '',
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
  if (lastGateScope && lastGateScope.outOfScope.length > 0) {
    out.gate_out_of_scope = lastGateScope.outOfScope
    if (final.cause === 'gate') {
      out.reason =
        (out.reason ? out.reason + ' ' : '') +
        (lastGateScope.inScope.length === 0
          ? '门禁命中全部落在白名单外既有文件：若属"通过必须改、契约禁止改"的死锁，收窄门禁范围（限定路径参数）或扩 allowed_files 后重派，或用 baseline_gate: true 预检。'
          : '门禁同时命中白名单内与白名单外内容：白名单外命中请人工甄别（可能为门禁范围过宽）。')
    }
  }
  if ((final.verdict === 'FAIL' || final.verdict === 'ESCALATED') && lastTail) out.error_tail = lastTail
  if (final.error_class) out.error_class = final.error_class
  if (final.verdict !== 'PASS') {
    try {
      out.workspace_delta = await collectWorkspaceDelta(ctx, repoRoot, useGit, exec, cfg, beforeText, lastAfterGitText, lastActual)
    } catch (e) {
      // 摘要失败不影响裁决本身：大声记录，主代理仍可从 files_changed 自行判断
      console.error('[dsh-pilot] 现场增量摘要失败:', e && e.message ? e.message : String(e))
    }
  }
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
          // 守卫自身出错 → 放行，不阻断宿主工具面；必须 undefined（null 会被当作拒绝）
          return undefined
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
          description: 'dsh-pilot 契约写作与裁决处理手册：契约五要素、门禁范围对齐与 Windows 陷阱、基础设施与契约失败分流、verdict 处理、防幻觉纪律',
          whenToUse: '起草 pilot_dispatch 契约前，或需要处理 FAIL/BLOCKED/ESCALATED 裁决时',
          source: 'runtime',
          invocation: { modelInvocable: cfg.exposure !== 'silent', userInvocable: true },
          content: PLAYBOOK,
        }),
      )
    }
  },
}
