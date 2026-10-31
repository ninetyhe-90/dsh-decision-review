import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as plugin from '../src/decision-model.mjs'

const validArgs = {
  point: 'candidate_selection',
  question: '哪个指标符合财务确认口径',
  primaryChoice: 'metric_a',
  options: [
    { id: 'metric_a', description: '系统预估收入', evidenceRefs: ['E1'] },
    { id: 'metric_b', description: '财务确认收入', evidenceRefs: ['E2'] },
  ],
  evidence: [
    { id: 'E1', fact: '系统预估口径包含未确认订单' },
    { id: 'E2', fact: '用户要求财务确认口径' },
  ],
  constraints: ['候选必须符合用户明确口径'],
}

function config(overrides = {}) {
  return {
    mode: 'advisory',
    baseUrl: 'https://decision.example.com',
    apiKeyEnv: 'DECISION_API_KEY',
    model: 'decision-model',
    allowedDecisionPoints: ['candidate_selection'],
    timeoutMs: 5000,
    minConfidence: 0.75,
    promptSection: true,
    promptSectionOrder: 30,
    systemExtra: '',
    ...overrides,
  }
}

function decisionOk(overrides = {}) {
  return {
    model: 'decision-model',
    answers: {
      recommendation: {
        type: 'choice',
        choice: 'metric_b',
        confidence: 0.91,
        probabilities: { metric_b: 1.0, metric_a: 0.0 },
        ...overrides,
      },
    },
    usage: { input_tokens: 396, output_tokens: 37 },
  }
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function stubFetch(impl) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return impl(url, options)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// 与 cordis LoggerService 相同的分发规则：exporter 按 levels[name] ?? levels.default ?? INFO 过滤。
const LOGGER_LEVEL = { error: 0, info: 1, warn: 2, debug: 3 }

function createContext() {
  const sections = []
  const tools = new Map()
  const logs = []
  const exporters = []
  const logger = (loggerName) => {
    const method = (type) => (...args) => {
      logs.push({ level: type, format: args[0], value: args[1] })
      for (const exporter of exporters) {
        const target = exporter.levels?.[loggerName] ?? exporter.levels?.default ?? LOGGER_LEVEL.info
        if (target < LOGGER_LEVEL[type]) continue
        exporter.export({ name: loggerName, type, level: LOGGER_LEVEL[type], args, ts: Date.now() })
      }
    }
    return { info: method('info'), warn: method('warn'), error: method('error'), debug: method('debug') }
  }
  logger.exporter = (exporter) => {
    exporters.push(exporter)
    return () => exporters.splice(exporters.indexOf(exporter), 1)
  }
  const listeners = new Map()
  const emit = (eventName, ...args) => {
    for (const listener of listeners.get(eventName) ?? []) listener(...args)
  }
  const ctx = {
    systemPrompt: {
      section(value) {
        sections.push(value)
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    on(eventName, listener) {
      if (!listeners.has(eventName)) listeners.set(eventName, [])
      listeners.get(eventName).push(listener)
      return () => listeners.get(eventName).splice(listeners.get(eventName).indexOf(listener), 1)
    },
    logger,
  }
  return { ctx, sections, tools, logs, exporters, logger, listeners, emit }
}

function stderrRecords(lines) {
  return lines.map((line) => {
    assert.ok(line.startsWith(plugin.STDERR_LOG_PREFIX), line)
    assert.ok(line.endsWith('\n'), line)
    assert.equal(line.slice(0, -1).includes('\n'), false, line)
    return JSON.parse(line.slice(plugin.STDERR_LOG_PREFIX.length))
  })
}

async function executeWith(fetchImpl, pluginConfig, args = validArgs, exec = {}) {
  const state = createContext()
  state.stderr = []
  const stub = stubFetch(fetchImpl)
  const keyBackup = process.env.DECISION_API_KEY
  process.env.DECISION_API_KEY = 'test-key'
  try {
    plugin.apply(state.ctx, {
      write: (line) => state.stderr.push(line),
      readTurnId: () => undefined,
      ...pluginConfig,
    })
    const tool = state.tools.get(plugin.toolName)
    assert.ok(tool)
    return { state, result: await tool.execute(args, exec), tool, calls: stub.calls }
  } finally {
    stub.restore()
    if (keyBackup === undefined) delete process.env.DECISION_API_KEY
    else process.env.DECISION_API_KEY = keyBackup
  }
}

test('导出固定工具名和可解析配置', () => {
  assert.equal(plugin.name, 'decision-review')
  assert.equal(plugin.toolName, '__decision_review')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])
  const parsed = plugin.Config({})
  assert.equal(parsed.mode, 'off')
  assert.equal(parsed.model, '')
  assert.equal(parsed.apiKeyEnv, 'DECISION_API_KEY')
})

test('off 模式不注册提示词和工具', () => {
  const state = createContext()
  plugin.apply(state.ctx, { mode: 'off' })
  assert.equal(state.sections.length, 0)
  assert.equal(state.tools.size, 0)
})

test('提示词要求主模型自主识别并复核实质性非确定选择', () => {
  const state = createContext()
  plugin.apply(state.ctx, config({
    allowedDecisionPoints: [
      'selection_review',
      'entity_resolution',
      'plan_consistency_review',
    ],
  }))
  assert.equal(state.sections.length, 1)
  const text = state.sections[0].text
  assert.match(text, /不得等待用户要求调用/)
  assert.match(text, /两个或以上合法候选/)
  assert.match(text, /实质影响最终回答、查询参数、实体匹配、指标口径、关系路径或后续动作/)
  assert.match(text, /可能、很可能、倾向于、推测或猜测/)
  assert.match(text, /用户已明确选择|确定性映射/)
  assert.match(text, /身份、权限或数据范围.*用户确认/)
})

test('advisory 返回可采纳建议并保持主模型最终执行权提示', async () => {
  const { result, tool, calls } = await executeWith(async () => jsonResponse(decisionOk()), config())
  assert.equal(tool.output.schema.properties.recommendation.type, 'string')
  assert.equal(tool.output.schema.properties.probabilities.additionalProperties, true)
  assert.equal(result.status, 'ok')
  assert.equal(result.recommendation, 'metric_b')
  assert.equal(result.confidence, 0.91)
  assert.deepEqual(result.risks, [])
  assert.equal(result.abstain, false)
  assert.equal(result.adoptable, true)
  assert.equal(calls.length, 1)
  const rendered = tool.output.render({}, result)[0].text
  assert.match(rendered, /建议/)
  assert.match(rendered, /由主模型决定是否采纳/)
  assert.match(rendered, /不替代现有权限、确认和安全机制/)
})

test('发往 DECISION 的请求映射 decision API 协议且携带凭据', async () => {
  const { calls } = await executeWith(async () => jsonResponse(decisionOk()), config())
  assert.equal(calls.length, 1)
  const { url, options } = calls[0]
  assert.equal(url, 'https://decision.example.com/v1/decision')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers.authorization, 'Bearer test-key')
  assert.equal(options.headers['content-type'], 'application/json')
  const body = JSON.parse(options.body)
  assert.equal(body.model, 'decision-model')
  assert.equal(body.state.primaryChoice, 'metric_a')
  assert.deepEqual(body.state.evidence, ['系统预估口径包含未确认订单', '用户要求财务确认口径'])
  assert.deepEqual(body.questions.recommendation.criteria, {
    metric_a: '系统预估收入',
    metric_b: '财务确认收入',
  })
  assert.equal(body.questions.recommendation.type, 'choice')
})

test('实体候选匹配可由 DECISION 独立复核', async () => {
  const args = {
    point: 'entity_resolution',
    question: '哪个销售实体最可能对应用户宋小丽',
    primaryChoice: 'lizzysong_MK1',
    options: [
      { id: 'xiaoxia_MK1', description: '销售 xiaoxia_MK1' },
      { id: 'lizzysong_MK1', description: '销售 lizzysong_MK1' },
    ],
    evidence: [{ id: 'E1', fact: '用户自述中文名为宋小丽' }],
    constraints: ['推荐结果仍需用户确认'],
  }
  const response = decisionOk({
    choice: 'lizzysong_MK1',
    confidence: 0.82,
    probabilities: { lizzysong_MK1: 0.82, xiaoxia_MK1: 0.18 },
  })
  const { result } = await executeWith(
    async () => jsonResponse(response),
    config({ allowedDecisionPoints: ['entity_resolution'] }),
    args,
  )
  assert.equal(result.recommendation, 'lizzysong_MK1')
  assert.equal(result.confidence, 0.82)
})

test('查询计划一致性可作为二元实质决策复核', async () => {
  const args = {
    point: 'plan_consistency_review',
    question: '当前查询计划是否与用户要求一致',
    primaryChoice: 'plan_consistent',
    options: [
      { id: 'plan_consistent', description: '计划与用户要求一致' },
      { id: 'needs_revision', description: '计划存在需要修正的不一致' },
    ],
    evidence: [{ id: 'E1', fact: '用户要求考核口径、未来三个月、按月汇总' }],
    constraints: ['不能替代正式查询的用户确认'],
  }
  const response = decisionOk({
    choice: 'plan_consistent',
    confidence: 0.9,
    probabilities: { plan_consistent: 0.9, needs_revision: 0.1 },
  })
  const { result } = await executeWith(
    async () => jsonResponse(response),
    config({ allowedDecisionPoints: ['plan_consistency_review'] }),
    args,
  )
  assert.equal(result.recommendation, 'plan_consistent')
  assert.equal(result.adoptable, true)
})

test('shadow 记录真实建议但不向主模型返回建议', async () => {
  const { result, state } = await executeWith(async () => jsonResponse(decisionOk()), config({ mode: 'shadow' }))
  assert.equal(result.status, 'shadow')
  assert.equal(result.primaryChoice, 'metric_a')
  assert.equal('recommendation' in result, false)
  assert.equal(state.logs.at(-1).value.agreement, false)
  assert.equal('recommendation' in state.logs.at(-1).value, false)
})

test('低置信度建议不可采纳', async () => {
  const { result } = await executeWith(async () => jsonResponse(decisionOk({ confidence: 0.6 })), config())
  assert.equal(result.status, 'not_adoptable')
  assert.equal(result.reasonCode, 'low_confidence')
  assert.equal(result.recommendation, 'metric_b')
  assert.equal(result.confidence, 0.6)
  assert.equal(result.adoptable, false)
})

test('置信度低于弃权线时判为证据不足弃权', async () => {
  const { result, tool } = await executeWith(async () => jsonResponse(decisionOk({ confidence: 0.3 })), config())
  assert.equal(result.status, 'abstained')
  assert.equal(result.reasonCode, 'insufficient_evidence')
  assert.equal(result.abstain, true)
  assert.equal(result.adoptable, false)
  assert.equal('recommendation' in result, false)
  const rendered = tool.output.render({}, result)[0].text
  assert.match(rendered, /建议/)
})

test('probabilities 随建议透传给主模型', async () => {
  const { result, tool } = await executeWith(async () => jsonResponse(decisionOk()), config())
  assert.deepEqual(result.probabilities, { metric_b: 1.0, metric_a: 0.0 })
  const rendered = tool.output.render({}, result)[0].text
  assert.match(rendered, /"probabilities":\{"metric_b":1,"metric_a":0\}/)
})

test('白名单外调用被拒绝且不请求 DECISION', async () => {
  const args = { ...validArgs, point: 'permission_check' }
  const { result, calls } = await executeWith(async () => jsonResponse(decisionOk()), config(), args)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reasonCode, 'DECISION_POINT_NOT_ALLOWED')
  assert.equal(calls.length, 0)
})

test('缺少 API key 时不分发请求', async () => {
  const state = createContext()
  const stub = stubFetch(async () => jsonResponse(decisionOk()))
  const keyBackup = process.env.DECISION_API_KEY
  delete process.env.DECISION_API_KEY
  try {
    const stderr = []
    plugin.apply(state.ctx, { ...config(), write: (line) => stderr.push(line), readTurnId: () => undefined })
    const tool = state.tools.get(plugin.toolName)
    const result = await tool.execute(validArgs, {})
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reasonCode, 'credential_unavailable')
    assert.equal(stub.calls.length, 0)
    assert.equal(stderrRecords(stderr).at(-1).reasonCode, 'credential_unavailable')
  } finally {
    stub.restore()
    if (keyBackup === undefined) delete process.env.DECISION_API_KEY
    else process.env.DECISION_API_KEY = keyBackup
  }
})

test('HTTP 错误映射为稳定错误码且不泄露响应细节', async () => {
  const cases = [
    [401, 'authentication_failed'],
    [403, 'authentication_failed'],
    [404, 'route_unavailable'],
    [402, 'quota_exceeded'],
    [429, 'rate_limited'],
    [413, 'context_too_large'],
    [400, 'invalid_request'],
    [500, 'provider_error'],
    [503, 'provider_error'],
    [504, 'upstream_timeout'],
  ]
  for (const [status, reasonCode] of cases) {
    const { result } = await executeWith(
      async () => new Response('secret internal detail', { status }),
      config(),
    )
    assert.equal(result.status, 'unavailable', `status ${status}`)
    assert.equal(result.reasonCode, reasonCode, `status ${status}`)
    assert.equal(JSON.stringify(result).includes('secret internal detail'), false)
  }
})

function gatewayError(status, code, headers = {}) {
  return new Response(JSON.stringify({
    error: {
      message: 'secret upstream message',
      type: 'gateway_error',
      code,
      retryable: false,
      suggestion: 'secret suggestion',
    },
  }), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-gateway-request-id': 'req-0123456789',
      'x-gateway-call-id': 'gwc_abcdef12',
      ...headers,
    },
  })
}

test('gateway 网关错误码优先于 HTTP 状态码映射', async () => {
  const cases = [
    [400, 'INVALID_REQUEST', 'invalid_request'],
    [400, 'UNKNOWN_MODEL', 'model_unsupported'],
    [400, 'MODEL_UNSUPPORTED', 'model_unsupported'],
    [400, 'MODEL_ENDPOINT_UNSUPPORTED', 'model_unsupported'],
    [401, 'AUTHENTICATION_ERROR', 'authentication_failed'],
    [403, 'AUTHORIZATION_ERROR', 'model_not_authorized'],
    [429, 'UPSTREAM_RATE_LIMITED', 'rate_limited'],
    [429, 'BUDGET_EXCEEDED', 'quota_exceeded'],
    [504, 'UPSTREAM_TIMEOUT', 'upstream_timeout'],
    [502, 'UPSTREAM_REJECTED', 'provider_error'],
    [503, 'MODEL_UNAVAILABLE', 'provider_error'],
  ]
  for (const [status, code, reasonCode] of cases) {
    const { result, state } = await executeWith(async () => gatewayError(status, code), config())
    assert.equal(result.status, 'unavailable', code)
    assert.equal(result.reasonCode, reasonCode, code)
    const event = state.logs.at(-1).value
    assert.equal(event.httpStatus, status, code)
    assert.equal(event.gatewayCode, code, code)
    assert.equal(event.gatewayRequestId, 'req-0123456789', code)
    assert.equal(event.gatewayCallId, 'gwc_abcdef12', code)
    const serialized = JSON.stringify({ result, event })
    assert.equal(serialized.includes('secret upstream message'), false, code)
    assert.equal(serialized.includes('secret suggestion'), false, code)
  }
})

test('非法网关错误码与请求 ID 被丢弃，回落到 HTTP 状态码', async () => {
  const { result, state } = await executeWith(
    async () => gatewayError(403, 'bad code\nINJECT', {
      'x-gateway-request-id': 'bad id with spaces',
      'x-gateway-call-id': '-leading-dash',
    }),
    config(),
  )
  assert.equal(result.reasonCode, 'authentication_failed')
  const event = state.logs.at(-1).value
  assert.equal('gatewayCode' in event, false)
  assert.equal('gatewayRequestId' in event, false)
  assert.equal('gatewayCallId' in event, false)
})

test('超大错误体不被解析，回落到 HTTP 状态码', async () => {
  const { result, state } = await executeWith(
    async () => new Response(JSON.stringify({ error: { code: 'UNKNOWN_MODEL', message: 'x'.repeat(5000) } }), { status: 400 }),
    config(),
  )
  assert.equal(result.reasonCode, 'invalid_request')
  assert.equal('gatewayCode' in state.logs.at(-1).value, false)
})

test('成功响应与解析失败都记录网关请求 ID', async () => {
  const headers = { 'x-gateway-request-id': 'req-0123456789', 'x-gateway-call-id': 'gwc_abcdef12' }
  const ok = await executeWith(async () => jsonResponse(decisionOk(), 200, headers), config())
  assert.equal(ok.result.status, 'ok')
  assert.equal(ok.state.logs.at(-1).value.gatewayRequestId, 'req-0123456789')
  assert.equal(ok.state.logs.at(-1).value.gatewayCallId, 'gwc_abcdef12')

  const bad = await executeWith(async () => new Response('not json', { status: 200, headers }), config())
  assert.equal(bad.result.reasonCode, 'invalid_response')
  assert.equal(bad.state.logs.at(-1).value.gatewayRequestId, 'req-0123456789')
})

test('读取错误体期间超时仍按 timeout 返回', { timeout: 1000 }, async () => {
  const { result } = await executeWith(
    async () => new Response(new ReadableStream({ start() {} }), { status: 500 }),
    config({ timeoutMs: 100 }),
  )
  assert.equal(result.reasonCode, 'timeout')
})

test('非法 JSON 与候选集外 choice 均判为 invalid_response', async () => {
  const badJson = await executeWith(async () => new Response('not json', { status: 200 }), config())
  assert.equal(badJson.result.status, 'unavailable')
  assert.equal(badJson.result.reasonCode, 'invalid_response')

  const outOfSet = await executeWith(async () => jsonResponse(decisionOk({ choice: 'metric_c' })), config())
  assert.equal(outOfSet.result.status, 'unavailable')
  assert.equal(outOfSet.result.reasonCode, 'invalid_response')
  assert.equal(outOfSet.result.primaryChoice, 'metric_a')
})

test('超大响应在解析前被拒绝', async () => {
  const byHeader = await executeWith(
    async () => new Response('{}', { status: 200, headers: { 'content-length': '100000' } }),
    config(),
  )
  assert.equal(byHeader.result.reasonCode, 'response_too_large')

  const byBody = await executeWith(
    async () => new Response('x'.repeat(5000), { status: 200, headers: { 'content-length': '3' } }),
    config(),
  )
  assert.equal(byBody.result.reasonCode, 'response_too_large')
})

test('独立超时在底层忽略 signal 时仍按时返回', { timeout: 1000 }, async () => {
  const startedAt = Date.now()
  const { result } = await executeWith(async () => new Promise(() => {}), config({ timeoutMs: 100 }))
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reasonCode, 'timeout')
  assert.equal(result.primaryChoice, 'metric_a')
  assert.ok(Date.now() - startedAt < 500)
})

test('父请求已取消时不分发 DECISION 请求', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const { result, calls } = await executeWith(async () => jsonResponse(decisionOk()), config(), validArgs, { signal: controller.signal })
  assert.equal(result.reasonCode, 'cancelled')
  assert.equal(calls.length, 0)
})

test('疑似凭据输入被拒绝且不请求 DECISION', async () => {
  const args = { ...validArgs, question: '使用 Authorization: Bearer abcdefghijklmnop 判断' }
  const { result, calls } = await executeWith(async () => jsonResponse(decisionOk()), config(), args)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reasonCode, 'SENSITIVE_INPUT')
  assert.equal(calls.length, 0)
})

test('日志包含模型路由与输入指纹，不包含请求内容', async () => {
  const { state } = await executeWith(async () => jsonResponse(decisionOk()), config())
  const event = state.logs.at(-1).value
  assert.equal(event.model, 'decision-model')
  assert.equal(event.decisionModel, 'decision-model')
  assert.equal(event.questionChars, validArgs.question.length)
  assert.equal(event.options, 2)
  assert.equal(event.evidenceItems, 2)
  assert.equal(JSON.stringify(event).includes('财务确认口径'), false)
})

test('提示词要求在向用户提问前完成复核', () => {
  const state = createContext()
  plugin.apply(state.ctx, config())
  assert.match(state.sections[0].text, /已经向用户提问后不要再调用本工具/)
})

test('注册的 stderr exporter 只收本插件的 error / info / warn', () => {
  const state = createContext()
  plugin.apply(state.ctx, { ...config(), write: () => {}, readTurnId: () => undefined })
  assert.equal(state.exporters.length, 1)
  const { levels } = state.exporters[0]
  assert.equal(levels[plugin.name], LOGGER_LEVEL.warn)
  assert.ok(levels.default < LOGGER_LEVEL.error)
})

test('off 模式不注册 stderr exporter', () => {
  const state = createContext()
  plugin.apply(state.ctx, { mode: 'off' })
  assert.equal(state.exporters.length, 0)
})

test('成功复核写一行 stderr，带网关 requestId 与 toolCallId', async () => {
  const headers = { 'x-gateway-request-id': 'req-0123456789', 'x-gateway-call-id': 'gwc_abcdef12' }
  const { state } = await executeWith(
    async () => jsonResponse(decisionOk(), 200, headers),
    config({ readTurnId: () => '64d1c9b1-e648-412b-8524-9647399fb125\n' }),
    validArgs,
    { callId: 'call_01bf1efe7b604199a1fc4c93' },
  )
  const records = stderrRecords(state.stderr)
  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record.level, 'info')
  assert.equal(record.msg, 'decision review')
  assert.equal(record.status, 'ok')
  assert.equal(record.requestId, '64d1c9b1-e648-412b-8524-9647399fb125')
  assert.equal(record.toolCallId, 'call_01bf1efe7b604199a1fc4c93')
  assert.equal(record.gatewayRequestId, 'req-0123456789')
  assert.equal(record.gatewayCallId, 'gwc_abcdef12')
  assert.equal(typeof record.latencyMs, 'number')
  assert.equal(JSON.stringify(record).includes('财务确认口径'), false)
  assert.equal(JSON.stringify(record).includes('test-key'), false)
})

test('网关报错写一行 stderr，带 httpStatus 与 gatewayCode', async () => {
  const { state } = await executeWith(async () => gatewayError(504, 'UPSTREAM_TIMEOUT'), config())
  const [record] = stderrRecords(state.stderr)
  assert.equal(record.status, 'unavailable')
  assert.equal(record.reasonCode, 'upstream_timeout')
  assert.equal(record.httpStatus, 504)
  assert.equal(record.gatewayCode, 'UPSTREAM_TIMEOUT')
  assert.equal(JSON.stringify(record).includes('secret upstream message'), false)
})

test('本地超时写一行 stderr，reasonCode=timeout 且带耗时', { timeout: 1000 }, async () => {
  const { state } = await executeWith(
    async () => new Promise(() => {}),
    config({ timeoutMs: 100 }),
    validArgs,
    { callId: 'call_timeout_1' },
  )
  const [record] = stderrRecords(state.stderr)
  assert.equal(record.status, 'unavailable')
  assert.equal(record.reasonCode, 'timeout')
  assert.equal(record.toolCallId, 'call_timeout_1')
  assert.ok(record.latencyMs >= 100)
})

test('入参被拒按 warn 写一行 stderr', async () => {
  const args = { ...validArgs, question: '使用 Authorization: Bearer abcdefghijklmnop 判断' }
  const { state } = await executeWith(async () => jsonResponse(decisionOk()), config(), args, { callId: 'call_rejected_1' })
  const [record] = stderrRecords(state.stderr)
  assert.equal(record.level, 'warn')
  assert.equal(record.msg, 'decision review rejected')
  assert.equal(record.status, 'rejected')
  assert.equal(record.reasonCode, 'SENSITIVE_INPUT')
  assert.equal(record.toolCallId, 'call_rejected_1')
  assert.equal(JSON.stringify(record).includes('abcdefghijklmnop'), false)
})

test('非法 requestId / callId 不进日志', async () => {
  const { state } = await executeWith(
    async () => jsonResponse(decisionOk()),
    config({ readTurnId: () => 'bad id\nINJECT' }),
    validArgs,
    { callId: '-leading-dash' },
  )
  const [record] = stderrRecords(state.stderr)
  assert.equal('requestId' in record, false)
  assert.equal('toolCallId' in record, false)
})

test('stderr exporter 忽略其他插件的日志', () => {
  const lines = []
  const exporter = plugin.createStderrExporter((line) => lines.push(line))
  exporter.export({ name: 'other-plugin', type: 'info', level: 1, args: ['hello %o', { a: 1 }] })
  assert.equal(lines.length, 0)
  exporter.export({ name: plugin.name, type: 'error', level: 0, args: ['decision review %o', { status: 'unavailable' }] })
  assert.deepEqual(stderrRecords(lines), [{ level: 'error', msg: 'decision review', status: 'unavailable' }])
})

test('每次复核发出 traceparent 并把 traceId 与网关回传的 trace 头写进日志', async () => {
  const headers = { 'x-platform-trace-id': 'feedc0de', 'x-trace-context-status': 'propagated' }
  const { state, calls } = await executeWith(async () => jsonResponse(decisionOk(), 200, headers), config())
  const traceparent = calls[0].options.headers.traceparent
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(traceparent)
  assert.ok(match, traceparent)
  const [record] = stderrRecords(state.stderr)
  assert.equal(record.traceId, match[1])
  assert.equal(record.platformTraceId, 'feedc0de')
  assert.equal(record.traceContextStatus, 'propagated')
  assert.equal(typeof record.headersMs, 'number')

  const second = await executeWith(async () => jsonResponse(decisionOk()), config())
  assert.notEqual(second.calls[0].options.headers.traceparent, traceparent)
})

test('等待响应头时超时：stage=request，带 timeoutMs 与 traceId', { timeout: 1000 }, async () => {
  const { state } = await executeWith(async () => new Promise(() => {}), config({ timeoutMs: 100 }))
  const [record] = stderrRecords(state.stderr)
  assert.equal(record.reasonCode, 'timeout')
  assert.equal(record.stage, 'request')
  assert.equal(record.timeoutMs, 100)
  assert.match(record.traceId, /^[0-9a-f]{32}$/)
  assert.equal('headersMs' in record, false)
})

test('读响应体时超时：stage=response_body，带 headersMs', { timeout: 1000 }, async () => {
  const { state } = await executeWith(
    async () => new Response(new ReadableStream({ start() {} }), { status: 500 }),
    config({ timeoutMs: 100 }),
  )
  const [record] = stderrRecords(state.stderr)
  assert.equal(record.reasonCode, 'timeout')
  assert.equal(record.stage, 'response_body')
  assert.equal(typeof record.headersMs, 'number')
})

test('网络层失败记录错误类名与错误码，不记录 message', async () => {
  const { result, state } = await executeWith(async () => {
    throw new TypeError('fetch failed http://10.0.0.1/secret', { cause: { code: 'ECONNRESET' } })
  }, config())
  assert.equal(result.reasonCode, 'provider_error')
  const [record] = stderrRecords(state.stderr)
  assert.equal(record.stage, 'request')
  assert.equal(record.errorName, 'TypeError')
  assert.equal(record.errorCode, 'ECONNRESET')
  assert.equal(JSON.stringify(record).includes('10.0.0.1'), false)
  assert.equal('timeoutMs' in record, false)
})

test('入参被拒时日志与返回值带字段路径和实际类型，主模型可据此修正', async () => {
  const args = { ...validArgs, constraints: [{ text: '候选必须符合用户明确口径' }] }
  const { result, state, tool } = await executeWith(async () => jsonResponse(decisionOk()), config(), args)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reasonCode, 'INVALID_STRING')
  assert.equal(result.field, 'constraints[0]')
  const [record] = stderrRecords(state.stderr)
  assert.equal(record.field, 'constraints[0]')
  assert.equal(record.actualType, 'object')
  assert.equal(JSON.stringify(record).includes('候选必须符合'), false)
  const rendered = tool.output.render({}, result)[0].text
  assert.match(rendered, /错误码：INVALID_STRING（字段 constraints\[0\]/)
})

test('宿主在 execute 之前拒绝调用时补写一行 failed 日志（stage=before_execute）', async () => {
  const state = createContext()
  const stderr = []
  plugin.apply(state.ctx, { ...config(), write: (line) => stderr.push(line), readTurnId: () => 'turn-1' })
  const denial = 'HOST_GATE_DENY {"tool":"__decision_review","reason":"turn_suspended_on_question","argumentsHash":null}'
  state.emit('tools/result', { name: plugin.toolName, callId: 'call_denied_1' }, {
    isError: true,
    content: [{ type: 'text', text: `Error: ${denial}\n本轮已经向用户提问并挂起` }],
    error: { message: `${denial}\n本轮已经向用户提问并挂起` },
  })
  const [record] = stderrRecords(stderr)
  assert.equal(record.level, 'warn')
  assert.equal(record.msg, 'decision review tool failed')
  assert.equal(record.status, 'failed')
  assert.equal(record.stage, 'before_execute')
  assert.equal(record.summary, denial)
  assert.equal(record.requestId, 'turn-1')
  assert.equal(record.toolCallId, 'call_denied_1')
})

test('失败摘要疑似含凭据时整行替换，错误码按标识符过滤', () => {
  const state = createContext()
  const stderr = []
  plugin.apply(state.ctx, { ...config(), write: (line) => stderr.push(line), readTurnId: () => undefined })
  state.emit('tools/result', { name: plugin.toolName, callId: 'call_x' }, {
    isError: true,
    content: [],
    error: { message: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', info: { name: 'X', code: 'BAD CODE\nINJECT' } },
  })
  state.emit('tools/result', { name: plugin.toolName, callId: 'call_y' }, {
    isError: true,
    content: [],
    error: { message: 'tool aborted', info: { name: 'HarnessError', code: 'ABORTED_BEFORE_DISPATCH' } },
  })
  const [redacted, aborted] = stderrRecords(stderr)
  assert.equal(redacted.summary, '[redacted]')
  assert.equal('errorCode' in redacted, false)
  assert.equal(aborted.errorCode, 'ABORTED_BEFORE_DISPATCH')
  assert.equal(aborted.summary, 'tool aborted')
})

test('其他工具与成功回执不产生 failed 日志；复核后回执失败记为 after_execute', async () => {
  const { state } = await executeWith(async () => jsonResponse(decisionOk()), config(), validArgs, { callId: 'call_ok_1' })
  state.emit('tools/result', { name: 'bash', callId: 'call_bash' }, { isError: true, content: [], error: { message: 'x' } })
  state.emit('tools/result', { name: plugin.toolName, callId: 'call_ok_1' }, { isError: false, content: [] })
  assert.equal(stderrRecords(state.stderr).length, 1)

  const again = await executeWith(async () => jsonResponse(decisionOk()), config(), validArgs, { callId: 'call_ok_2' })
  again.state.emit('tools/result', { name: plugin.toolName, callId: 'call_ok_2' }, {
    isError: true,
    content: [],
    error: { message: 'tool "__decision_review" returned invalid output', info: { code: 'INVALID_TOOL_OUTPUT' } },
  })
  const records = stderrRecords(again.state.stderr)
  assert.equal(records.length, 2)
  assert.equal(records[1].stage, 'after_execute')
  assert.equal(records[1].errorCode, 'INVALID_TOOL_OUTPUT')
})

test('execute 内抛出非入参异常时回执记为 stage=execute', async () => {
  const state = createContext()
  const stderr = []
  plugin.apply(state.ctx, { ...config(), write: (line) => stderr.push(line), readTurnId: () => undefined })
  const tool = state.tools.get(plugin.toolName)
  const args = { ...validArgs }
  Object.defineProperty(args, 'point', { enumerable: true, get() { throw new Error('boom') } })
  await assert.rejects(tool.execute(args, { callId: 'call_throw_1' }), /boom/)
  state.emit('tools/result', { name: plugin.toolName, callId: 'call_throw_1' }, {
    isError: true,
    content: [],
    error: { message: 'boom' },
  })
  const [record] = stderrRecords(stderr)
  assert.equal(record.stage, 'execute')
  assert.equal(record.summary, 'boom')
})

test('读取轮次标识抛错不影响复核', async () => {
  const { result, state } = await executeWith(
    async () => jsonResponse(decisionOk()),
    config({ readTurnId: () => { throw new Error('io') } }),
  )
  assert.equal(result.status, 'ok')
  assert.equal('requestId' in stderrRecords(state.stderr)[0], false)
})

test('requestIdFile 配置时从文件读取轮次标识', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'decision-review-'))
  const file = join(directory, 'turn.id')
  writeFileSync(file, 'turn-from-file\n')
  const state = createContext()
  state.stderr = []
  const stub = stubFetch(async () => jsonResponse(decisionOk()))
  try {
    plugin.apply(state.ctx, { ...config({ requestIdFile: file }), write: (line) => state.stderr.push(line) })
    const tool = state.tools.get(plugin.toolName)
    await tool.execute(validArgs, { callId: 'call_file_1' })
    const [record] = stderrRecords(state.stderr)
    assert.equal(record.requestId, 'turn-from-file')
    assert.equal(record.toolCallId, 'call_file_1')
  } finally {
    stub.restore()
    rmSync(directory, { recursive: true, force: true })
  }
})
