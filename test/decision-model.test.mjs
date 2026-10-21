import assert from 'node:assert/strict'
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

function createContext() {
  const sections = []
  const tools = new Map()
  const logs = []
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
    logger() {
      return {
        info(format, value) {
          logs.push({ level: 'info', format, value })
        },
        warn(format, value) {
          logs.push({ level: 'warn', format, value })
        },
        error() {},
        debug() {},
      }
    },
  }
  return { ctx, sections, tools, logs }
}

async function executeWith(fetchImpl, pluginConfig, args = validArgs, exec = {}) {
  const state = createContext()
  const stub = stubFetch(fetchImpl)
  const keyBackup = process.env.DECISION_API_KEY
  process.env.DECISION_API_KEY = 'test-key'
  try {
    plugin.apply(state.ctx, pluginConfig)
    const tool = state.tools.get(plugin.toolName)
    assert.ok(tool)
    return { state, result: await tool.execute(args, exec), tool, calls: stub.calls }
  } finally {
    stub.restore()
    if (keyBackup === undefined) delete process.env.DECISION_API_KEY
    else process.env.DECISION_API_KEY = keyBackup
  }
}

test('导出固定内部工具名和可解析配置', () => {
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
    plugin.apply(state.ctx, config())
    const tool = state.tools.get(plugin.toolName)
    const result = await tool.execute(validArgs, {})
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reasonCode, 'credential_unavailable')
    assert.equal(stub.calls.length, 0)
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
