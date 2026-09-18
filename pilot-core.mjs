// pilot-core.mjs — dsh-pilot 纯逻辑核心（零 import、可独立单测）
//
// 契约校验、路径白名单、git 输出解析、回执核验、verdict 状态机、
// 子代理 prompt 组装、shell 写目标提取（守卫用，fail-open）。
// 任何 DSH 依赖只允许出现在 index.mjs。

// ---------- 回执 schema（派发给支持 outputSchema 的 provider） ----------
// 注意：这是 subagents.start 的原始 JSON Schema（对象根子集，required 数组合法）；
// 与 harness.defineTool 的 value schema DSL（属性级 required 布尔 + 显式 additionalProperties）是两套话语。
export const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked'] },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    test_ran: { type: 'boolean' },
    exit_code: { type: 'integer' },
  },
  required: ['status', 'files_changed', 'test_ran'],
}

// ---------- 契约校验 ----------

// 白名单字段制：schema 刻意没有 code/patch 字段，出现任何未知键都拒绝——
// 这是"主代理物理上递不了代码"的硬保证（DESIGN §4.2）。
const CONTRACT_KEYS = new Set(['goal', 'detail', 'context', 'allowed_files', 'acceptance_cmd', 'tier', 'max_retries'])

export function validateContract(input) {
  const errors = []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['契约必须是对象'] }
  }
  const unknown = Object.keys(input).filter((k) => !CONTRACT_KEYS.has(k))
  if (unknown.length > 0) errors.push('契约不允许字段: ' + unknown.join(', '))

  let goal
  if (typeof input.goal === 'string' && input.goal.trim() !== '') {
    goal = input.goal.trim()
    if (goal.length > 140) errors.push('goal 超过 140 字')
  } else {
    errors.push('goal 必须是非空字符串')
  }

  let detail
  if (typeof input.detail === 'string' && input.detail.trim() !== '') {
    detail = input.detail
  } else {
    errors.push('detail 必须是非空字符串')
  }

  let context = []
  if (input.context !== undefined) {
    if (Array.isArray(input.context)) {
      context = []
      input.context.forEach((item, i) => {
        const p = item && typeof item === 'object' && typeof item.path === 'string' ? normalizeRelPath(item.path) : ''
        if (!p) {
          errors.push('context[' + i + '] 缺少有效 path')
          return
        }
        const note = item && typeof item.note === 'string' && item.note.trim() !== '' ? item.note : undefined
        context.push(note === undefined ? { path: p } : { path: p, note })
      })
    } else {
      errors.push('context 必须是数组')
    }
  }

  let allowedFiles = []
  if (Array.isArray(input.allowed_files)) {
    if (input.allowed_files.length === 0) {
      errors.push('allowed_files 不能为空')
    } else {
      allowedFiles = input.allowed_files.map((p) => (typeof p === 'string' ? normalizeRelPath(p) : ''))
      if (allowedFiles.some((p) => p === '')) errors.push('allowed_files 每项必须是非空字符串')
    }
  } else {
    errors.push('allowed_files 必须是非空字符串数组')
  }

  const tier = input.tier === undefined ? 'standard' : input.tier
  if (tier !== 'fast' && tier !== 'standard') errors.push('tier 只能是 fast 或 standard')

  let acceptanceCmd
  if (input.acceptance_cmd !== undefined && input.acceptance_cmd !== null && input.acceptance_cmd !== '') {
    if (typeof input.acceptance_cmd !== 'string') errors.push('acceptance_cmd 必须是字符串')
    else acceptanceCmd = input.acceptance_cmd
  }
  if (tier === 'standard' && !acceptanceCmd) errors.push('tier=standard 必须提供 acceptance_cmd')

  let maxRetries = 2
  if (input.max_retries !== undefined) {
    if (Number.isInteger(input.max_retries) && input.max_retries >= 0 && input.max_retries <= 5) maxRetries = input.max_retries
    else errors.push('max_retries 必须是 0..5 的整数')
  }

  if (errors.length > 0) return { ok: false, errors }
  const contract = { goal, detail, context, allowed_files: allowedFiles, tier, max_retries: maxRetries }
  if (acceptanceCmd !== undefined) contract.acceptance_cmd = acceptanceCmd
  return { ok: true, contract }
}

// ---------- 路径与 diff ----------

export function normalizeRelPath(p) {
  if (typeof p !== 'string') return ''
  return p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

export function pathAllowed(relPath, allowedFiles) {
  const rel = normalizeRelPath(relPath)
  if (rel === '' || !Array.isArray(allowedFiles)) return false
  return allowedFiles.some((raw) => {
    const e = normalizeRelPath(raw)
    if (e === '') return false
    if (rel === e) return true
    if (e.endsWith('/') && rel.startsWith(e)) return true
    if (rel.startsWith(e + '/')) return true
    return false
  })
}

export function parseNameOnly(output) {
  if (typeof output !== 'string') return []
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

export function parsePorcelain(output) {
  if (typeof output !== 'string') return []
  const out = []
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const status = line.slice(0, 2).trim()
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    if (path === '') continue
    out.push({ status, path })
  }
  return out
}

export function porcelainPaths(lines) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(lines) ? lines : []) {
    if (item && typeof item.path === 'string' && !seen.has(item.path)) {
      seen.add(item.path)
      out.push(item.path)
    }
  }
  return out
}

export function checkScope(actualPaths, allowedFiles) {
  const violations = (Array.isArray(actualPaths) ? actualPaths : []).filter((p) => !pathAllowed(p, allowedFiles))
  return { ok: violations.length === 0, violations }
}

export function checkReceipt(receipt, actualPaths) {
  const claimed = receipt && Array.isArray(receipt.files_changed) ? receipt.files_changed.map(normalizeRelPath) : []
  const actual = (Array.isArray(actualPaths) ? actualPaths : []).map(normalizeRelPath)
  const actualSet = new Set(actual)
  const claimedSet = new Set(claimed)
  const claimedNotChanged = [...new Set(claimed.filter((p) => p !== '' && !actualSet.has(p)))]
  const changedNotClaimed = [...new Set(actual.filter((p) => p !== '' && !claimedSet.has(p)))]
  return { truthful: claimedNotChanged.length === 0 && changedNotClaimed.length === 0, claimedNotChanged, changedNotClaimed }
}

// ---------- 回执 ----------

export function validateReceipt(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['回执必须是对象'] }
  }
  const errors = []
  const ALLOWED = new Set(['status', 'summary', 'files_changed', 'test_ran', 'exit_code'])
  const unknown = Object.keys(value).filter((k) => !ALLOWED.has(k))
  if (unknown.length > 0) errors.push('回执不允许字段: ' + unknown.join(', '))
  if (value.status !== 'completed' && value.status !== 'blocked') errors.push('status 必须是 completed 或 blocked')
  if (!Array.isArray(value.files_changed) || value.files_changed.some((p) => typeof p !== 'string')) {
    errors.push('files_changed 必须是字符串数组')
  }
  if (typeof value.test_ran !== 'boolean') errors.push('test_ran 必须是布尔值')
  if (value.summary !== undefined && typeof value.summary !== 'string') errors.push('summary 必须是字符串')
  if (value.exit_code !== undefined && !Number.isInteger(value.exit_code)) errors.push('exit_code 必须是整数')
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, receipt: value }
}

// 自由文本兜底提取：扫描平衡的 {...} 候选（跳过字符串字面量内的花括号），
// 第一个能通过 validateReceipt 的候选获胜。
export function extractReceiptJson(text) {
  if (typeof text !== 'string') return null
  const candidates = []
  let depth = 0
  let start = -1
  let quote = null
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      if (depth > 0) quote = ch
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start !== -1) {
          candidates.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue // 非 JSON 候选，跳过
    }
    const v = validateReceipt(parsed)
    if (v.ok) return v.receipt
  }
  return null
}

// ---------- 裁决 ----------

// 确定性裁决状态机（DESIGN §4.3/§6.2）：顺序即优先级。
export function determineVerdict(input) {
  const i = input || {}
  if (typeof i.dispatchError === 'string' && i.dispatchError !== '') {
    return { verdict: 'FAIL', retryable: false, reason: i.dispatchError }
  }
  if (i.childStopReason !== 'completed') {
    if (i.childStopReason === 'aborted') return { verdict: 'BLOCKED', retryable: false, reason: '子代理被中止' }
    if (i.childStopReason === 'refusal') return { verdict: 'BLOCKED', retryable: false, reason: '子代理拒绝执行' }
    if (i.childStopReason === 'error') return { verdict: 'FAIL', retryable: true, reason: '子代理执行错误' }
    if (i.childStopReason === 'max-tokens') return { verdict: 'FAIL', retryable: true, reason: '子代理输出超长' }
    return { verdict: 'FAIL', retryable: false, reason: '子代理异常结束: ' + String(i.childStopReason) }
  }
  if (i.receipt == null) {
    return { verdict: 'FAIL', retryable: true, reason: '子代理未返回有效回执' }
  }
  if (i.receipt.status === 'blocked') {
    return { verdict: 'BLOCKED', retryable: false, reason: i.receipt.summary || '子代理报告无法完成' }
  }
  if (i.scope && i.scope.ok === false) {
    return { verdict: 'FAIL', retryable: true, reason: '越界修改: ' + i.scope.violations.join('、') }
  }
  if (i.truth && i.truth.truthful === false) {
    return {
      verdict: 'FAIL',
      retryable: true,
      reason:
        '回执虚报：声称改了但没改 ' +
        (i.truth.claimedNotChanged.join('、') || '无') +
        '；实际改了但没报 ' +
        (i.truth.changedNotClaimed.join('、') || '无'),
    }
  }
  if (i.gate && (i.gate.exitCode !== 0 || i.gate.timedOut === true)) {
    return { verdict: 'FAIL', retryable: true, reason: '门禁失败（exit ' + i.gate.exitCode + (i.gate.timedOut ? '，超时' : '') + '）: ' + i.gate.cmd }
  }
  return { verdict: 'PASS', retryable: false }
}

// 重试耗尽后调用：可重试的 FAIL 升级为 ESCALATED。
export function escalate(result) {
  if (result && result.verdict === 'FAIL' && result.retryable) {
    return { verdict: 'ESCALATED', retryable: false, reason: result.reason }
  }
  return result
}

// ---------- 子代理 prompt 组装 ----------

export function buildChildPrompt(contract, feedback) {
  const c = contract || {}
  const lines = []
  lines.push('# 任务契约', '', '目标：' + (c.goal || ''), '', '## 需求细节', c.detail || '')
  if (Array.isArray(c.context) && c.context.length > 0) {
    lines.push('', '## 相关上下文')
    for (const item of c.context) lines.push('- ' + item.path + (item.note ? ': ' + item.note : ''))
  }
  lines.push('', '## 修改白名单（只允许改这些相对路径）')
  for (const p of c.allowed_files || []) lines.push('- ' + p)
  lines.push('', '## 验收')
  lines.push(c.acceptance_cmd ? '完成后此命令必须通过：' + c.acceptance_cmd : '本任务为小微改动（tier=fast）：不得引入回归，禁止新增测试。')
  lines.push(
    '',
    '## 纪律',
    '- 只修改白名单内文件；白名单外的任何写入都会被拒绝。',
    '- 不新增文档/脚本类文件；不引入契约未声明的新依赖。',
    '- 完成后仅返回如下 JSON 回执，不要输出其他散文：',
    '  {"status":"completed","summary":"一句话总结","files_changed":["相对路径"],"test_ran":true,"exit_code":0}',
    '- 若无法完成，status 改为 "blocked"，并在 summary 说明原因。',
  )
  if (typeof feedback === 'string' && feedback.trim() !== '') {
    lines.push('', '## 上一轮失败反馈（必须解决后再交付）', feedback)
  }
  return lines.join('\n')
}

// ---------- 杂项 ----------

export function tailText(text, maxChars = 2000) {
  if (typeof text !== 'string') return ''
  return text.length <= maxChars ? text : text.slice(-maxChars)
}

export function loadConfig(partial = {}) {
  const base = {
    provider: 'spawn',
    model: undefined,
    exposure: 'pointer',
    guard: true,
    maxRetries: 2,
    gateTimeoutMs: 300000,
    feedbackMaxChars: 2000,
    sandboxMode: undefined, // 'read-only'|'workspace-write'|'danger-full-access'；缺省交部署默认
  }
  for (const key of Object.keys(base)) {
    if (partial && partial[key] !== undefined) base[key] = partial[key]
  }
  return base
}

// ---------- 非 git 工作区降级（DESIGN §10：白名单文件哈希快照） ----------

// FNV-1a 32 位：字节流 → 8 位 hex。降级快照用；碰撞概率对变更检测足够低，
// 不追求密码学强度（这里只回答"文件内容变没变"）。
// 鸭子类型判定字节流：动态插件域里 TextEncoder 来自宿主 realm，instanceof Uint8Array 恒 false。
export function fnv1aHex(bytes) {
  if (typeof bytes !== 'object' || bytes === null || typeof bytes.length !== 'number') return null
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] & 0xff
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// 快照差集：before/after 均为 { rel: hash|null }（null = 文件不存在）。
// 返回发生变化的 rel 数组（消失/出现/内容变化都算）。
export function snapshotChanged(before, after) {
  const out = []
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})])
  for (const rel of keys) {
    if ((before || {})[rel] !== (after || {})[rel]) out.push(rel)
  }
  return out.sort()
}

// ---------- shell 写目标提取（守卫用；尽力而为、fail-open） ----------

const PWSH_WRITE_CMDLETS = new Set(['set-content', 'add-content', 'out-file', 'new-item', 'copy-item', 'move-item', 'remove-item', 'rename-item'])
const BASH_WRITE_CMDS = new Set(['tee', 'cp', 'mv', 'rm'])
const WRITE_OPTION = /^-(path|literalpath|destination|filepath)$/i
const REDIRECT = /^(?:[12]?>>?|<>)$/
const CMD_BOUNDARY = /^[|;&]$/

// 最小引号感知分词："..."/'...' 内空白保留、引号剥除；不支持转义引号（fail-open 可接受）。
function splitCommandArgs(input) {
  const out = []
  let cur = ''
  let quote = null
  for (const ch of String(input)) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

function addWriteTarget(out, p) {
  if (p && !p.includes('://') && !p.startsWith('--')) out.add(p)
}

// 写命令的裸参数目标规则：copy/move 目标在最后（-Destination 位），remove 全取，
// 其余取第一个（-Path 位）。引号字面量只有落在这些位置才算写目标。
function positionalTargets(cmd, positional) {
  if (cmd === 'copy-item' || cmd === 'move-item' || cmd === 'cp' || cmd === 'mv') {
    return positional.length ? [positional[positional.length - 1]] : []
  }
  if (cmd === 'remove-item' || cmd === 'rm') return positional
  return positional.length ? [positional[0]] : []
}

export function extractShellWriteTargets(command) {  const out = new Set()
  const tokens = splitCommandArgs(String(command))
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (REDIRECT.test(t)) {
      if (tokens[i + 1] !== undefined) addWriteTarget(out, tokens[i + 1])
      continue
    }
    if (t === 'dd') {
      for (let j = i + 1; j < tokens.length && !CMD_BOUNDARY.test(tokens[j]); j++) {
        const m = /^of=(.+)$/.exec(tokens[j])
        if (m) addWriteTarget(out, m[1])
      }
      continue
    }
    const low = t.toLowerCase()
    if (!PWSH_WRITE_CMDLETS.has(low) && !BASH_WRITE_CMDS.has(low)) continue
    let j = i + 1
    while (j < tokens.length && !CMD_BOUNDARY.test(tokens[j])) j++
    const rest = tokens.slice(i + 1, j)
    const positional = []
    let afterDoubleDash = false
    for (let k = 0; k < rest.length; k++) {
      const tok = rest[k]
      if (afterDoubleDash) {
        positional.push(tok)
        continue
      }
      if (tok === '--') {
        afterDoubleDash = true
        continue
      }
      if (tok.startsWith('-')) {
        if (WRITE_OPTION.test(tok)) {
          if (rest[k + 1] !== undefined) addWriteTarget(out, rest[k + 1])
          k++
        } else if (rest[k + 1] !== undefined && !rest[k + 1].startsWith('-')) {
          k++ // 未知选项：跳过其值，防把选项值误当位置参数
        }
      } else {
        positional.push(tok)
      }
    }
    for (const p of positionalTargets(low, positional)) addWriteTarget(out, p)
  }
  return [...out]
}
