// test/index.test.mjs — index.mjs 宿主面集成测试（mock ctx，零 DSH 宿主依赖）
// 覆盖：插件契约、零常驻纪律（P0 只注册一个工具）、persona/skill 注入与 exposure 档、
// 契约校验拒绝、派发→回执→门禁→裁决全链路、重试反馈、BLOCKED 不重试、
// provider 缺失大声报错、白名单守卫 allow/deny、verdict render。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

// ---------- mock ctx ----------

function mockCtx(root) {
  const tools = new Map()
  const sections = []
  const skills = []
  let guardFn = null
  const ctx = {
    get(name) {
      return ctx[name]
    },
    effect(fn) {
      return fn()
    },
    on() {
      return () => {}
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
      get(name) {
        return tools.get(name)
      },
      guard(fn) {
        guardFn = fn
        return () => {
          guardFn = null
        }
      },
    },
    systemPrompt: {
      section(s) {
        sections.push(s)
        return () => {}
      },
    },
    skills: {
      register(s) {
        skills.push(s)
        return () => {}
      },
    },
    workspaceRegistry: { resolveByPath: async () => undefined },
    shell: null, // 由用例注入
    subagents: null, // 由用例注入
  }
  return { ctx, tools, sections, skills, getGuard: () => guardFn }
}

function agent(id, cwd) {
  return { id, session: { header: { cwd } } }
}

const execOf = (ag) => ({ agent: ag, signal: new AbortController().signal })

// mock shell：git status 按 statusScript 输出；其他命令按 gateQueue 依次取 exitCode
function mockShell(statusScript, gateQueue) {
  const calls = []
  return {
    calls,
    resolve(req) {
      return req
    },
    async run(spec) {
      calls.push(spec.command)
      if (spec.command.startsWith('git status --porcelain')) {
        return { exitCode: 0, timedOut: false, stdout: { text: statusScript.shift() ?? '' }, stderr: { text: '' } }
      }
      const exitCode = gateQueue.length ? gateQueue.shift() : 0
      return {
        exitCode,
        timedOut: false,
        stdout: { text: exitCode === 0 ? 'ok' : '' },
        stderr: { text: exitCode === 0 ? '' : 'FAIL tests/a.test.ts\nexpected 1 to be 2' },
      }
    },
  }
}

// mock subagents：start 按脚本依次出 child；childId=child-N；记录 prompts
function mockSubagents(script) {
  let n = 0
  return {
    prompts: [],
    started: 0,
    getProvider(name) {
      if (name === 'spawn') return { name, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }
      return undefined
    },
    list() {
      return ['spawn']
    },
    async start(_name, req) {
      this.started += 1
      this.prompts.push(req.prompt[0].text)
      const item = script.shift()
      if (!item) throw new Error('脚本耗尽')
      n += 1
      const childId = 'child-' + n
      return {
        id: childId,
        localAgent: { id: childId },
        result: item.result,
        dispose() {},
      }
    },
  }
}

const okReceipt = (files) => ({
  stopReason: 'completed',
  structured: { status: 'completed', summary: '完成', files_changed: files, test_ran: true, exit_code: 0 },
  output: [],
})

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-pilot-test-'))
}

const CONTRACT = {
  goal: '实现 token 签发',
  detail: '在 src/auth.ts 增加 sign(uid: string): string',
  allowed_files: ['src/auth.ts'],
  acceptance_cmd: 'pnpm vitest run tests/auth.test.ts',
  tier: 'standard',
}

// ---------- 用例 ----------

test('index.mjs 导出合法 Cordis 插件契约（name + apply）', () => {
  assert.equal(typeof plugin, 'object')
  assert.equal(plugin.name, 'dsh-pilot')
  assert.equal(typeof plugin.apply, 'function')
})

test('零常驻纪律：P0 只注册 pilot_dispatch 一个工具', () => {
  const { ctx, tools } = mockCtx()
  plugin.apply(ctx, {})
  assert.deepEqual([...tools.keys()], ['pilot_dispatch'])
  const def = tools.get('pilot_dispatch')
  assert.equal(typeof def.execute, 'function')
  assert.equal(typeof def.output.render, 'function')
  // 契约 schema 刻意没有 code/patch 字段
  assert.equal(def.parameters.properties.code, undefined)
  assert.equal(def.parameters.properties.patch, undefined)
})

test('persona 指针与 playbook skill 注入；exposure=silent 时 persona 不注入且 skill 对模型不可见', () => {
  const a = mockCtx()
  plugin.apply(a.ctx, {})
  assert.equal(a.sections.length, 1)
  assert.ok(a.sections[0].text.includes('pilot_dispatch'))
  assert.equal(a.skills.length, 1)
  assert.equal(a.skills[0].invocation.modelInvocable, true)
  assert.equal(a.skills[0].invocation.userInvocable, true)
  assert.ok(a.skills[0].content.includes('verdict'))

  const b = mockCtx()
  plugin.apply(b.ctx, { exposure: 'silent' })
  assert.equal(b.sections.length, 0)
  assert.equal(b.skills.length, 1)
  assert.equal(b.skills[0].invocation.modelInvocable, false)
})

test('契约非法：FAIL 且不派发', async () => {
  const root = await tmpRoot()
  const { ctx } = mockCtx(root)
  const sub = mockSubagents([])
  ctx.subagents = sub
  plugin.apply(ctx, {})
  const out = await ctx.tools.get('pilot_dispatch').execute({ goal: 'x', detail: 'd' }, execOf(agent('master', root)))
  assert.equal(out.verdict, 'FAIL')
  assert.ok(out.reason.includes('契约非法'))
  assert.equal(sub.started, 0)
})

test('派发全链路 PASS：回执 + 门禁 exit 0 + diff 白名单内', async () => {
  const root = await tmpRoot()
  const { ctx } = mockCtx(root)
  const sub = mockSubagents([{ result: Promise.resolve(okReceipt(['src/auth.ts'])) }])
  ctx.subagents = sub
  ctx.shell = mockShell(['', ' M src/auth.ts\n'], [0])
  plugin.apply(ctx, {})
  const out = await ctx.tools.get('pilot_dispatch').execute({ ...CONTRACT }, execOf(agent('master', root)))
  assert.equal(out.verdict, 'PASS')
  assert.equal(out.attempts, 1)
  assert.deepEqual(out.files_changed, ['src/auth.ts'])
  assert.equal(out.gate.exit_code, 0)
  assert.equal(sub.started, 1)
  // 子代理 prompt 携带契约要素与回执格式
  assert.ok(sub.prompts[0].includes('实现 token 签发'))
  assert.ok(sub.prompts[0].includes('src/auth.ts'))
  assert.ok(sub.prompts[0].includes('pnpm vitest run tests/auth.test.ts'))
  assert.ok(sub.prompts[0].includes('files_changed'))
})

test('门禁失败触发重试：第二轮带反馈后 PASS，attempts=2', async () => {
  const root = await tmpRoot()
  const { ctx } = mockCtx(root)
  const sub = mockSubagents([
    { result: Promise.resolve(okReceipt(['src/auth.ts'])) },
    { result: Promise.resolve(okReceipt(['src/auth.ts'])) },
  ])
  ctx.subagents = sub
  ctx.shell = mockShell(['', ' M src/auth.ts\n', ' M src/auth.ts\n'], [1, 0])
  plugin.apply(ctx, {})
  const out = await ctx.tools.get('pilot_dispatch').execute({ ...CONTRACT }, execOf(agent('master', root)))
  assert.equal(out.verdict, 'PASS')
  assert.equal(out.attempts, 2)
  assert.ok(sub.prompts[1].includes('上一轮失败反馈'))
  assert.ok(sub.prompts[1].includes('exit 1'))
})

test('子代理 refusal → BLOCKED，不重试', async () => {
  const root = await tmpRoot()
  const { ctx } = mockCtx(root)
  const sub = mockSubagents([{ result: Promise.resolve({ stopReason: 'refusal', output: [] }) }])
  ctx.subagents = sub
  ctx.shell = mockShell(['', ''], [])
  plugin.apply(ctx, {})
  const out = await ctx.tools.get('pilot_dispatch').execute({ ...CONTRACT }, execOf(agent('master', root)))
  assert.equal(out.verdict, 'BLOCKED')
  assert.equal(sub.started, 1)
})

test('重试耗尽 → ESCALATED', async () => {
  const root = await tmpRoot()
  const { ctx } = mockCtx(root)
  const sub = mockSubagents([
    { result: Promise.resolve(okReceipt(['src/auth.ts'])) },
    { result: Promise.resolve(okReceipt(['src/auth.ts'])) },
    { result: Promise.resolve(okReceipt(['src/auth.ts'])) },
  ])
  ctx.subagents = sub
  ctx.shell = mockShell(['', ' M src/auth.ts\n', ' M src/auth.ts\n', ' M src/auth.ts\n'], [1, 1, 1])
  plugin.apply(ctx, { maxRetries: 2 })
  const out = await ctx.tools.get('pilot_dispatch').execute({ ...CONTRACT }, execOf(agent('master', root)))
  assert.equal(out.verdict, 'ESCALATED')
  assert.equal(sub.started, 3)
})

test('provider 不存在：大声 FAIL 且不派发', async () => {
  const root = await tmpRoot()
  const { ctx } = mockCtx(root)
  ctx.subagents = { getProvider: () => undefined, list: () => ['fork'], start: () => {} }
  ctx.shell = mockShell(['', ''], [])
  plugin.apply(ctx, { provider: 'nope' })
  const out = await ctx.tools.get('pilot_dispatch').execute({ ...CONTRACT }, execOf(agent('master', root)))
  assert.equal(out.verdict, 'FAIL')
  assert.ok(out.reason.includes('nope'))
  assert.ok(out.reason.includes('fork'))
})

test('回执虚报（files_changed 与实际 diff 不符）→ FAIL + 重试反馈含虚报说明', async () => {
  const root = await tmpRoot()
  const { ctx } = mockCtx(root)
  const sub = mockSubagents([
    { result: Promise.resolve(okReceipt(['src/other.ts'])) }, // 虚报：实际改的是 src/auth.ts
    { result: Promise.resolve(okReceipt(['src/auth.ts'])) },
  ])
  ctx.subagents = sub
  ctx.shell = mockShell(['', ' M src/auth.ts\n', ' M src/auth.ts\n'], [0, 0])
  plugin.apply(ctx, {})
  const out = await ctx.tools.get('pilot_dispatch').execute({ ...CONTRACT }, execOf(agent('master', root)))
  assert.equal(out.verdict, 'PASS')
  assert.equal(out.attempts, 2)
  assert.ok(sub.prompts[1].includes('回执虚报'))
  assert.ok(sub.prompts[1].includes('src/other.ts'))
})

test('白名单守卫：子代理写白名单内放行、白名单外拒绝、其他代理不受管', async () => {
  const root = await tmpRoot()
  const { ctx, getGuard } = mockCtx(root)
  let releaseChild
  const gate = new Promise((r) => {
    releaseChild = r
  })
  const sub = mockSubagents([
    { result: gate.then(() => Promise.resolve(okReceipt(['src/auth.ts']))) },
  ])
  ctx.subagents = sub
  ctx.shell = mockShell(['', ' M src/auth.ts\n'], [0])
  plugin.apply(ctx, {})
  const master = agent('master', root)
  const pending = ctx.tools.get('pilot_dispatch').execute({ ...CONTRACT }, execOf(master))
  // start 已返回、子代理运行中：守卫映射应生效
  await new Promise((r) => setTimeout(r, 20))
  const guard = getGuard()
  assert.equal(typeof guard, 'function')
  assert.equal(guard({ name: 'write', arguments: { file_path: join(root, 'src', 'auth.ts') }, agent: { id: 'child-1' } }), null)
  assert.ok(guard({ name: 'write', arguments: { file_path: join(root, 'src', 'evil.ts') }, agent: { id: 'child-1' } }).includes('白名单'))
  assert.equal(guard({ name: 'write', arguments: { file_path: join(root, 'src', 'evil.ts') }, agent: { id: 'other-session' } }), null)
  assert.ok(guard({ name: 'bash', arguments: { command: `echo x > ${join(root, 'evil.txt')}` }, agent: { id: 'child-1' } }).includes('白名单'))
  releaseChild()
  const out = await pending
  assert.equal(out.verdict, 'PASS')
})

test('非 git 工作区降级：哈希快照检测白名单文件变化，门禁照常执行', async () => {
  const root = await tmpRoot()
  const { ctx } = mockCtx(root)
  let releaseResult
  const sub = mockSubagents([
    {
      // 手动释放：before 快照完成后才解析 result 并翻转 written（防微任务提前写入）
      result: new Promise((res) => {
        releaseResult = () => res(okReceipt(['hello.txt']))
      }).then((r) => {
        written = true
        return r
      }),
    },
  ])
  ctx.subagents = sub
  // git 命令一律 exit 128（非仓库）；门禁 exit 0
  const gitFails = {
    resolve(r) {
      return r
    },
    async run(spec) {
      if (spec.command.startsWith('git ')) return { exitCode: 128, timedOut: false, stdout: { text: '' }, stderr: { text: 'fatal: not a git repository' } }
      return { exitCode: 0, timedOut: false, stdout: { text: 'ok' }, stderr: { text: '' } }
    },
  }
  ctx.shell = gitFails
  // fs mock：hello.txt 任务前不存在，任务后内容为 pilot-ok\n
  let written = false
  ctx.fs = {
    async resolve(p) {
      return { path: p }
    },
    async readText(target) {
      if (!written) throw new Error('ENOENT: ' + target.path)
      return 'pilot-ok\n'
    },
  }
  plugin.apply(ctx, {})
  const pending = ctx.tools
    .get('pilot_dispatch')
    .execute(
      { goal: '写冒烟文件', detail: '写 hello.txt 内容 pilot-ok', allowed_files: ['hello.txt'], acceptance_cmd: 'node check.cjs' },
      execOf(agent('master', root)),
    )
  await new Promise((r) => setTimeout(r, 20)) // 等 before 快照落定
  releaseResult()
  const out = await pending
  assert.equal(out.verdict, 'PASS', JSON.stringify(out))
  assert.deepEqual(out.files_changed, ['hello.txt'])
  assert.equal(out.gate.exit_code, 0)
})

test('renderVerdict：紧凑文本，PASS 不带处理提示，FAIL 带 error_tail 与处理指引', () => {
  const { ctx } = mockCtx()
  plugin.apply(ctx, {})
  const render = ctx.tools.get('pilot_dispatch').output.render
  const pass = render({}, { verdict: 'PASS', files_changed: ['a.ts'], attempts: 1, gate: { cmd: 't', exit_code: 0 } })
  assert.ok(pass[0].text.includes('verdict: PASS'))
  assert.ok(!pass[0].text.includes('处理'))
  const fail = render({}, { verdict: 'FAIL', reason: '门禁失败', files_changed: [], attempts: 1, error_tail: 'ERR' })
  assert.ok(fail[0].text.includes('FAIL'))
  assert.ok(fail[0].text.includes('ERR'))
  assert.ok(fail[0].text.includes('勿原样重派'))
})
