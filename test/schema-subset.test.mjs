// test/schema-subset.test.mjs — 静态工具 schema 子集守护
//
// 背景：静态 tools.register 走 dsh-tools 的 assertSupportedJsonSchema（JSON Schema 子集）。
// M1 挂载崩溃根因：VERDICT_OUTPUT_SCHEMA 的 verdict 节点 enum 缺 type，dsh-tools 报
// "schema.properties.verdict.enum requires type or oneOf"，apply 抛错 → 整个插件树装载失败。
// 本文件镜像该校验器的子集规则（规则源自 @deepseek-ai/dsh-tools lib/index.js checkSchemaNode），
// 对注册后的 parameters 与 output.schema 做全量检查，防此类"静态 schema 不合法"回归。
// 注：镜像规则可能随 dsh 版本演进偏移；发布前以真实 dsh 装载验证为准。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../index.mjs'

// ---------- 镜像 dsh-tools 子集校验 ----------

const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const OBJECT_ONLY = new Set(['properties', 'required', 'additionalProperties'])
const ARRAY_ONLY = new Set(['items'])
const SCALAR_ONLY = new Set(['enum', 'const'])
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function collectSchemaViolations(node, path, violations) {
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue
    if (key === 'description' || key === 'title' || key === 'default' || key === 'examples') continue // 注解关键字
    violations.push(path + '.' + key + ' is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)')
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    violations.push(path + ' cannot declare both type and oneOf')
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of CONSTRAINT_KEYWORDS) {
      if (key !== 'type' && key !== 'oneOf' && Object.hasOwn(node, key)) violations.push(path + '.' + key + ' requires type or oneOf')
    }
    return // 纯注解节点：无约束，放行
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(path + '.oneOf must be an array of at least two schemas')
    else node.oneOf.forEach((branch, i) => collectSchemaViolations(branch, path + '.oneOf[' + i + ']', violations))
    return
  }
  const type = node.type
  if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
    violations.push(path + '.type must be one of ' + [...SCHEMA_TYPES].join('/'))
    return
  }
  if (OBJECT_ONLY.has('properties') && Object.hasOwn(node, 'properties') && type !== 'object') violations.push(path + '.properties is not supported on type "' + type + '"')
  if (Object.hasOwn(node, 'required') && type !== 'object') violations.push(path + '.required is not supported on type "' + type + '"')
  if (Object.hasOwn(node, 'additionalProperties') && type !== 'object') violations.push(path + '.additionalProperties is not supported on type "' + type + '"')
  if (Object.hasOwn(node, 'items') && type !== 'array') violations.push(path + '.items is not supported on type "' + type + '"')
  if (Object.hasOwn(node, 'enum') && !SCALAR_TYPES.has(type)) violations.push(path + '.enum is not supported on type "' + type + '"')
  if (Object.hasOwn(node, 'const') && !SCALAR_TYPES.has(type)) violations.push(path + '.const is not supported on type "' + type + '"')
  if (type === 'object' && Object.hasOwn(node, 'properties')) {
    if (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties)) violations.push(path + '.properties must be an object of schemas')
    else for (const [key, child] of Object.entries(node.properties)) collectSchemaViolations(child, path + '.properties.' + key, violations)
  }
  if (type === 'array' && Object.hasOwn(node, 'items')) collectSchemaViolations(node.items, path + '.items', violations)
  if (Object.hasOwn(node, 'enum')) {
    const values = node.enum
    if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === type)) {
      violations.push(path + '.enum must be a non-empty array of ' + type + ' values')
    }
  }
  if (Object.hasOwn(node, 'const') && typeof node.const !== type) violations.push(path + '.const must be a ' + type + ' value')
}

function unsupportedSchemaViolations(schema) {
  const violations = []
  collectSchemaViolations(schema, 'schema', violations)
  return violations
}

// ---------- mini mock ctx（只需覆盖 apply 期用到的面） ----------

function mockCtx() {
  const tools = new Map()
  return {
    ctx: {
      get() {
        return undefined
      },
      effect(fn) {
        return fn()
      },
      tools: {
        register(def) {
          tools.set(def.name, def)
          return () => tools.delete(def.name)
        },
        get(name) {
          return tools.get(name)
        },
        guard() {
          return () => {}
        },
      },
    },
    tools,
  }
}

// ---------- 用例 ----------

test('pilot_dispatch 的 parameters 与 output.schema 通过 dsh-tools 子集校验（防 M1 挂载崩溃回归）', () => {
  const { ctx, tools } = mockCtx()
  plugin.apply(ctx, {})
  const def = tools.get('pilot_dispatch')
  assert.ok(def, '工具应已注册')
  assert.deepEqual(unsupportedSchemaViolations(def.parameters), [])
  assert.deepEqual(unsupportedSchemaViolations(def.output.schema), [])
})

test('镜像校验器会拒绝 enum 缺 type 的 schema（负向自检）', () => {
  const v = unsupportedSchemaViolations({ type: 'object', properties: { verdict: { enum: ['PASS'] } } })
  assert.ok(v.some((s) => s.includes('verdict.enum requires type or oneOf')), JSON.stringify(v))
})

test('镜像校验器会拒绝类型错位的 enum 值（负向自检）', () => {
  const v = unsupportedSchemaViolations({ type: 'object', properties: { n: { type: 'integer', enum: ['x'] } } })
  assert.ok(v.some((s) => s.includes('enum must be a non-empty array of integer values')), JSON.stringify(v))
})