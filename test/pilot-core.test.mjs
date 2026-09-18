// test/pilot-core.test.mjs — pilot-core.mjs 纯函数单测（零依赖、零 IO）

import { test } from 'node:test'
import assert from 'node:assert/strict'
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
} from '../pilot-core.mjs'

// ---------- 契约校验 ----------

test('validateContract：最小合法契约通过并填充缺省', () => {
  const v = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], acceptance_cmd: 'pnpm test' })
  assert.equal(v.ok, true)
  assert.equal(v.contract.tier, 'standard')
  assert.equal(v.contract.max_retries, 2)
  assert.deepEqual(v.contract.context, [])
  assert.equal(v.contract.acceptance_cmd, 'pnpm test')
})

test('validateContract：goal 超长被拒', () => {
  const v = validateContract({ goal: 'x'.repeat(141), detail: 'd', allowed_files: ['a.ts'] })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('goal')))
})

test('validateContract：缺 allowed_files 被拒；空数组也被拒', () => {
  assert.equal(validateContract({ goal: 'g', detail: 'd' }).ok, false)
  assert.equal(validateContract({ goal: 'g', detail: 'd', allowed_files: [] }).ok, false)
})

test('validateContract：含 code 字段被拒且错误信息点名 code（递不了代码的硬保证）', () => {
  const v = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], code: 'const x = 1' })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('code')))
})

test('validateContract：tier=standard 缺 acceptance_cmd 被拒；fast 无验收命令通过', () => {
  const a = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], tier: 'standard' })
  assert.equal(a.ok, false)
  assert.ok(a.errors.some((e) => e.includes('acceptance_cmd')))
  const b = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], tier: 'fast' })
  assert.equal(b.ok, true)
})

test('validateContract：max_retries 越界与非整数被拒', () => {
  assert.equal(validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], max_retries: 6 }).ok, false)
  assert.equal(validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], max_retries: 1.5 }).ok, false)
  assert.equal(validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], max_retries: -1 }).ok, false)
})

test('validateContract：未知键 foo 被拒', () => {
  const v = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], foo: 1 })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.includes('foo')))
})

test('validateContract：baseline_gate 布尔通过、非布尔被拒、缺省不出现在契约', () => {
  const a = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], acceptance_cmd: 't', baseline_gate: true })
  assert.equal(a.ok, true)
  assert.equal(a.contract.baseline_gate, true)
  const b = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], baseline_gate: 'yes' })
  assert.equal(b.ok, false)
  assert.ok(b.errors.some((e) => e.includes('baseline_gate')))
  const c = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], acceptance_cmd: 't' })
  assert.equal(c.contract.baseline_gate, undefined)
})

test('validateContract：context 项缺 path 被拒；note 空串视为无', () => {
  const a = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], context: [{ note: 'n' }] })
  assert.equal(a.ok, false)
  const b = validateContract({ goal: 'g', detail: 'd', allowed_files: ['a.ts'], acceptance_cmd: 't', context: [{ path: 'a.ts', note: '' }] })
  assert.equal(b.ok, true)
  assert.deepEqual(b.contract.context, [{ path: 'a.ts' }])
})

test('validateContract：非法输入整体被拒', () => {
  assert.equal(validateContract(null).ok, false)
  assert.equal(validateContract('x').ok, false)
  assert.equal(validateContract([1]).ok, false)
})

// ---------- 路径 ----------

test('normalizeRelPath：反斜杠、连续斜杠、./ 前缀、尾斜杠归一', () => {
  assert.equal(normalizeRelPath('.\\a\\\\b/'), 'a/b')
  assert.equal(normalizeRelPath('./x'), 'x')
  assert.equal(normalizeRelPath('a//b'), 'a/b')
  assert.equal(normalizeRelPath(42), '')
})

test('pathAllowed：精确、目录前缀（带/不带斜杠）、白名单外、空串', () => {
  const wl = ['src/auth.ts', 'src/lib/', 'tests']
  assert.equal(pathAllowed('src/auth.ts', wl), true)
  assert.equal(pathAllowed('src/lib/util.ts', wl), true)
  assert.equal(pathAllowed('src/lib/util.ts'.replace('util', 'deep/nested'), wl), true)
  assert.equal(pathAllowed('tests/a.test.ts', wl), true)
  assert.equal(pathAllowed('src/authz.ts', wl), false)
  assert.equal(pathAllowed('', wl), false)
  assert.equal(pathAllowed('src/auth.ts', []), false)
})

// ---------- git 输出解析 ----------

test('parsePorcelain：M/??/A、重命名取新路径、CRLF、跳过空行', () => {
  const lines = parsePorcelain(' M src/a.ts\r\n?? new.txt\nA  added.md\nR  old.ts -> new.ts\n\n')
  assert.deepEqual(lines, [
    { status: 'M', path: 'src/a.ts' },
    { status: '??', path: 'new.txt' },
    { status: 'A', path: 'added.md' },
    { status: 'R', path: 'new.ts' },
  ])
  assert.deepEqual(porcelainPaths([...lines, ...lines]), ['src/a.ts', 'new.txt', 'added.md', 'new.ts'])
})

// ---------- 范围与回执核验 ----------

test('checkScope：越界进 violations；目录前缀覆盖不算越界', () => {
  const a = checkScope(['src/auth.ts', 'src/evil.ts'], ['src/auth.ts'])
  assert.equal(a.ok, false)
  assert.deepEqual(a.violations, ['src/evil.ts'])
  assert.equal(checkScope(['src/lib/x.ts'], ['src/lib/']).ok, true)
  assert.equal(checkScope([], ['a']).ok, true)
})

test('checkReceipt：双向一致 truthful；虚报与漏报分列', () => {
  const t = checkReceipt({ files_changed: ['src/a.ts'] }, ['src/a.ts'])
  assert.equal(t.truthful, true)
  const over = checkReceipt({ files_changed: ['src/ghost.ts', 'src/a.ts'] }, ['src/a.ts'])
  assert.equal(over.truthful, false)
  assert.deepEqual(over.claimedNotChanged, ['src/ghost.ts'])
  const under = checkReceipt({ files_changed: [] }, ['src/a.ts'])
  assert.deepEqual(under.changedNotClaimed, ['src/a.ts'])
})

// ---------- 回执校验与提取 ----------

test('validateReceipt：合法、缺必填、多余字段、类型错误', () => {
  const ok = validateReceipt({ status: 'completed', files_changed: ['a'], test_ran: true })
  assert.equal(ok.ok, true)
  assert.equal(validateReceipt({ status: 'completed', files_changed: ['a'] }).ok, false) // 缺 test_ran
  assert.equal(validateReceipt({ status: 'completed', files_changed: ['a'], test_ran: true, code: 'x' }).ok, false)
  assert.equal(validateReceipt({ status: 'nope', files_changed: ['a'], test_ran: true }).ok, false)
  assert.equal(validateReceipt({ status: 'completed', files_changed: [1], test_ran: true }).ok, false)
  assert.equal(validateReceipt(null).ok, false)
})

test('extractReceiptJson：散文包裹、嵌套花括号、纯散文、多 JSON 取第一个合法的', () => {
  const r1 = extractReceiptJson('执行完成。\n{"status":"completed","summary":"好","files_changed":["a.ts"],"test_ran":true}\n以上。')
  assert.equal(r1.summary, '好')

  const nested = '前置 {"a":{"b":"{不含回执}"},"c":1} 尾随 {"status":"completed","files_changed":["b.ts"],"test_ran":false}'
  assert.equal(extractReceiptJson(nested).files_changed[0], 'b.ts')

  assert.equal(extractReceiptJson('没有任何 JSON'), null)
  assert.equal(extractReceiptJson('{"status":"completed"}'), null) // JSON 但不是回执
})

// ---------- 裁决状态机 ----------

test('determineVerdict：全绿 PASS', () => {
  const v = determineVerdict({
    childStopReason: 'completed',
    receipt: { status: 'completed', files_changed: [], test_ran: true },
    scope: { ok: true, violations: [] },
    truth: { truthful: true, claimedNotChanged: [], changedNotClaimed: [] },
    gate: { cmd: 't', exitCode: 0, timedOut: false },
  })
  assert.deepEqual(v, { verdict: 'PASS', retryable: false })
})

test('determineVerdict：失败分支带 cause 与 error_class', () => {
  const base = { childStopReason: 'completed', receipt: { status: 'completed', files_changed: [], test_ran: true }, scope: { ok: true, violations: [] }, truth: { truthful: true, claimedNotChanged: [], changedNotClaimed: [] } }
  const g = determineVerdict({ ...base, gate: { cmd: 't', exitCode: 2, timedOut: false } })
  assert.equal(g.cause, 'gate')
  assert.equal(g.error_class, 'contract')
  const t = determineVerdict({ ...base, truth: { truthful: false, claimedNotChanged: ['g'], changedNotClaimed: ['h'] } })
  assert.equal(t.cause, 'truth')
  const e = determineVerdict({ ...base, childStopReason: 'error' })
  assert.equal(e.cause, 'child-error')
  assert.equal(e.error_class, 'unknown')
  const d = determineVerdict({ dispatchError: 'sandbox 崩了' })
  assert.equal(d.cause, 'dispatch')
  assert.equal(d.error_class, 'infrastructure')
})

test('escalate：升级保留 cause 与 error_class（耗尽场景仍需处置分流）', () => {
  const up = escalate({ verdict: 'FAIL', retryable: true, cause: 'gate', error_class: 'contract', reason: 'r' })
  assert.equal(up.verdict, 'ESCALATED')
  assert.equal(up.cause, 'gate')
  assert.equal(up.error_class, 'contract')
})

test('determineVerdict：stopReason 分支', () => {
  const base = { receipt: { status: 'completed', files_changed: [], test_ran: true }, scope: { ok: true, violations: [] }, truth: { truthful: true, claimedNotChanged: [], changedNotClaimed: [] } }
  assert.equal(determineVerdict({ ...base, childStopReason: 'aborted' }).verdict, 'BLOCKED')
  assert.equal(determineVerdict({ ...base, childStopReason: 'refusal' }).verdict, 'BLOCKED')
  const err = determineVerdict({ ...base, childStopReason: 'error' })
  assert.equal(err.verdict, 'FAIL')
  assert.equal(err.retryable, true)
  const mt = determineVerdict({ ...base, childStopReason: 'max-tokens' })
  assert.equal(mt.verdict, 'FAIL')
  assert.equal(mt.retryable, true)
  assert.equal(determineVerdict({ ...base, childStopReason: '???' }).retryable, false)
})

test('determineVerdict：无回执 → FAIL 可重试；status=blocked → BLOCKED', () => {
  const r = determineVerdict({ childStopReason: 'completed', receipt: null })
  assert.equal(r.verdict, 'FAIL')
  assert.equal(r.retryable, true)
  const b = determineVerdict({ childStopReason: 'completed', receipt: { status: 'blocked', files_changed: [], test_ran: false, summary: '缺上下文' } })
  assert.equal(b.verdict, 'BLOCKED')
  assert.ok(b.reason.includes('缺上下文'))
})

test('determineVerdict：越界、虚报、门禁失败、派发失败', () => {
  const base = { childStopReason: 'completed', receipt: { status: 'completed', files_changed: [], test_ran: true } }
  const s = determineVerdict({ ...base, scope: { ok: false, violations: ['x.ts'] }, truth: { truthful: true, claimedNotChanged: [], changedNotClaimed: [] } })
  assert.ok(s.reason.includes('越界修改'))
  const t = determineVerdict({ ...base, scope: { ok: true, violations: [] }, truth: { truthful: false, claimedNotChanged: ['g'], changedNotClaimed: ['h'] } })
  assert.ok(t.reason.includes('回执虚报'))
  const g = determineVerdict({ ...base, scope: { ok: true, violations: [] }, truth: { truthful: true, claimedNotChanged: [], changedNotClaimed: [] }, gate: { cmd: 't', exitCode: 2, timedOut: false } })
  assert.ok(g.reason.includes('exit 2'))
  const g0 = determineVerdict({ ...base, scope: { ok: true, violations: [] }, truth: { truthful: true, claimedNotChanged: [], changedNotClaimed: [] }, gate: { cmd: 't', exitCode: 0, timedOut: false } })
  assert.equal(g0.verdict, 'PASS')
  const d = determineVerdict({ dispatchError: 'provider 不存在' })
  assert.equal(d.verdict, 'FAIL')
  assert.equal(d.retryable, false)
})

test('escalate：FAIL+retryable → ESCALATED；BLOCKED/PASS 原样', () => {
  assert.equal(escalate({ verdict: 'FAIL', retryable: true, reason: 'r' }).verdict, 'ESCALATED')
  assert.equal(escalate({ verdict: 'BLOCKED', retryable: false }).verdict, 'BLOCKED')
  assert.equal(escalate({ verdict: 'PASS', retryable: false }).verdict, 'PASS')
})

// ---------- prompt 组装 ----------

test('buildChildPrompt：含契约要素与回执格式；fast 档禁新增测试；feedback 节按需出现', () => {
  const std = buildChildPrompt({
    goal: '实现 sign',
    detail: '签名函数',
    context: [{ path: 'src/auth.ts', note: 'sign(uid): string' }],
    allowed_files: ['src/auth.ts', 'tests/'],
    acceptance_cmd: 'pnpm vitest run',
  })
  assert.ok(std.includes('实现 sign'))
  assert.ok(std.includes('签名函数'))
  assert.ok(std.includes('src/auth.ts: sign(uid): string'))
  assert.ok(std.includes('- tests/'))
  assert.ok(std.includes('pnpm vitest run'))
  assert.ok(std.includes('files_changed'))
  assert.ok(!std.includes('上一轮失败反馈'))

  const fast = buildChildPrompt({ goal: 'g', detail: 'd', context: [], allowed_files: ['a.md'] })
  assert.ok(fast.includes('禁止新增测试'))
  assert.ok(!fast.includes('## 相关上下文'))

  const fb = buildChildPrompt({ goal: 'g', detail: 'd', context: [], allowed_files: ['a'] }, '门禁失败：exit 1')
  assert.ok(fb.includes('上一轮失败反馈'))
  assert.ok(fb.includes('exit 1'))
})

// ---------- 门禁输出路径提取 ----------

test('extractGatePaths：行号后缀、Windows 路径、尾随标点、URL 排除、去重', () => {
  assert.deepEqual(extractGatePaths('FAIL tests\\test_agent_loop.py:272\nexpected 1 to be 2'), ['tests/test_agent_loop.py'])
  assert.deepEqual(extractGatePaths('at C:/repo/src/a.ts:27:5 in foo'), ['C:/repo/src/a.ts'])
  assert.deepEqual(extractGatePaths('hits in tests/test_x.py(272), src/evil.ts;'), ['tests/test_x.py', 'src/evil.ts'])
  assert.deepEqual(extractGatePaths('see https://example.com/a.js for docs'), [])
  assert.deepEqual(extractGatePaths('dup src/a.ts again src/a.ts:9'), ['src/a.ts'])
  assert.deepEqual(extractGatePaths(''), [])
  assert.deepEqual(extractGatePaths(null), [])
})

// ---------- 基础设施失败识别 ----------

test('classifyInfra：沙箱 ACL/Win32/EPERM/spawn ENOENT/拒绝访问 命中；普通错误与空值不命中', () => {
  for (const hit of [
    'SetNamedSecurityInfoW (Win32 5): sandbox ACL denied',
    'spawn git ENOENT',
    'EPERM: operation not permitted',
    'Access is denied. (os error 5)',
    '系统提示：拒绝访问。',
  ]) {
    assert.equal(classifyInfra(hit), true, hit)
  }
  for (const miss of [null, '', 'upstream model API timeout', 'expected 1 to be 2', '模型输出超长']) {
    assert.equal(classifyInfra(miss), false, String(miss))
  }
})

test('isCommandNotFoundExit：127 与 9009 命中，其余不命中', () => {
  assert.equal(isCommandNotFoundExit(127), true)
  assert.equal(isCommandNotFoundExit(9009), true)
  assert.equal(isCommandNotFoundExit(1), false)
  assert.equal(isCommandNotFoundExit(0), false)
  assert.equal(isCommandNotFoundExit(null), false)
})

// ---------- 杂项 ----------

test('tailText：截头留尾；缺省 2000；非字符串空串', () => {
  assert.equal(tailText('abcdef', 3), 'def')
  assert.equal(tailText('ab', 3), 'ab')
  assert.equal(tailText('x'.repeat(2500)).length, 2000)
  assert.equal(tailText(null), '')
})

test('loadConfig：缺省、undefined 不覆盖、多余键剥除、不改入参', () => {
  const partial = { provider: 'fork', model: undefined, junk: 1 }
  const cfg = loadConfig(partial)
  assert.equal(cfg.provider, 'fork')
  assert.equal(cfg.model, undefined)
  assert.equal(cfg.exposure, 'pointer')
  assert.equal(cfg.junk, undefined)
  assert.deepEqual(partial, { provider: 'fork', model: undefined, junk: 1 })
  assert.equal(loadConfig().maxRetries, 2)
})

// ---------- shell 写目标提取 ----------

test('extractShellWriteTargets：重定向与追加重定向', () => {
  assert.deepEqual(extractShellWriteTargets('echo x > out.txt'), ['out.txt'])
  assert.ok(extractShellWriteTargets('foo 2>> log.txt').includes('log.txt'))
})

test('extractShellWriteTargets：pwsh 写命令与位置参数规则', () => {
  assert.deepEqual(extractShellWriteTargets('Set-Content -Path a.txt -Value x'), ['a.txt'])
  assert.deepEqual(extractShellWriteTargets('Copy-Item src.ts dst.ts'), ['dst.ts'])
  assert.deepEqual(extractShellWriteTargets('rm a.ts b.ts'), ['a.ts', 'b.ts'])
})

test('extractShellWriteTargets：引号字面量不误报、只读命令无目标、dd of=、命令边界', () => {
  assert.deepEqual(extractShellWriteTargets('echo "not-a-path" > f.txt'), ['f.txt'])
  assert.deepEqual(extractShellWriteTargets('cat note.txt'), [])
  assert.deepEqual(extractShellWriteTargets('dd if=a of=b.img'), ['b.img'])
  assert.deepEqual(extractShellWriteTargets('grep x; rm victim.ts'), ['victim.ts'])
  assert.deepEqual(extractShellWriteTargets('git commit -m "msg" -- a.ts'), [])
})

// ---------- 非 git 降级 ----------

test('fnv1aHex：确定性、内容敏感、非对象返回 null、跨 realm 类字节流可用', () => {
  const a = fnv1aHex(new TextEncoder().encode('pilot-ok\n'))
  assert.equal(a, fnv1aHex(new TextEncoder().encode('pilot-ok\n')))
  assert.notEqual(a, fnv1aHex(new TextEncoder().encode('pilot-no\n')))
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.equal(fnv1aHex('nope'), null)
  assert.equal(fnv1aHex(null), null)
  // 模拟跨 realm：普通对象形式的字节序列也能算
  const fake = { length: 3, 0: 104, 1: 105, 2: 33 }
  assert.match(fnv1aHex(fake), /^[0-9a-f]{8}$/)
})

test('snapshotChanged：出现/消失/内容变化都算变化；无变化返回空', () => {
  assert.deepEqual(snapshotChanged({ 'a.ts': 'aaaa' }, { 'a.ts': 'bbbb' }), ['a.ts'])
  assert.deepEqual(snapshotChanged({ 'a.ts': 'aaaa' }, { 'a.ts': null }), ['a.ts'])
  assert.deepEqual(snapshotChanged({ 'a.ts': null }, { 'a.ts': 'aaaa' }), ['a.ts'])
  assert.deepEqual(snapshotChanged({ 'a.ts': 'aaaa', 'b.ts': 'bbbb' }, { 'a.ts': 'aaaa', 'b.ts': 'bbbb' }), [])
  assert.deepEqual(snapshotChanged({}, { 'new.ts': 'cccc' }), ['new.ts'])
})
