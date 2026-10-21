import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DecisionInputError,
  buildDecisionRequest,
  normalizeDecisionInput,
  parseDecisionResponse,
  projectDecisionResult,
  validatePluginConfig,
} from '../src/decision-core.mjs'

const baseConfig = {
  mode: 'advisory',
  baseUrl: 'https://decision.example.com',
  apiKeyEnv: 'DECISION_API_KEY',
  model: 'decision-model',
  allowedDecisionPoints: ['candidate_selection'],
  timeoutMs: 5000,
  minConfidence: 0.75,
}

const baseInput = {
  point: 'candidate_selection',
  question: '哪个指标与用户要求的收入确认口径一致',
  primaryChoice: 'metric_a',
  options: [
    { id: 'metric_a', description: '系统预估收入', evidenceRefs: ['E1'] },
    { id: 'metric_b', description: '财务确认收入', evidenceRefs: ['E2'] },
  ],
  evidence: [
    { id: 'E1', fact: '系统预估口径包含尚未确认的订单' },
    { id: 'E2', fact: '用户要求使用财务确认口径' },
  ],
  constraints: ['只能从候选集合中选择'],
}

test('off 模式不要求 baseUrl、model 和决策点白名单', () => {
  const config = validatePluginConfig({ mode: 'off' })
  assert.equal(config.mode, 'off')
})

test('非 off 模式要求 baseUrl 显式配置或通过环境变量提供', () => {
  const backup = process.env.DECISION_BASE_URL
  delete process.env.DECISION_BASE_URL
  try {
    assert.throws(
      () => validatePluginConfig({ mode: 'shadow', allowedDecisionPoints: ['candidate_selection'] }),
      /baseUrl/,
    )
    process.env.DECISION_BASE_URL = 'https://decision.example.com'
    const config = validatePluginConfig({
      mode: 'shadow',
      model: 'decision-model',
      allowedDecisionPoints: ['candidate_selection'],
    })
    assert.equal(config.baseUrl, 'https://decision.example.com')
    const schemaDefaultConfig = validatePluginConfig({
      mode: 'shadow',
      baseUrl: '',
      model: 'decision-model',
      allowedDecisionPoints: ['candidate_selection'],
    })
    assert.equal(schemaDefaultConfig.baseUrl, 'https://decision.example.com')
  } finally {
    if (backup === undefined) delete process.env.DECISION_BASE_URL
    else process.env.DECISION_BASE_URL = backup
  }
})

test('baseUrl 必须是合法的 http 或 https URL', () => {
  assert.throws(() => validatePluginConfig({ ...baseConfig, baseUrl: 'not a url' }), /baseUrl/)
  assert.throws(() => validatePluginConfig({ ...baseConfig, baseUrl: 'file:///etc/passwd' }), /baseUrl/)
  assert.throws(() => validatePluginConfig({ ...baseConfig, baseUrl: 'ftp://decision.example.com' }), /baseUrl/)
})

test('baseUrl 必须是根地址，拒绝 /v1 后缀、完整端点、内嵌凭据与查询串', () => {
  for (const baseUrl of [
    'https://gw.example.com/v1',
    'https://gw.example.com/v1/',
    'https://gw.example.com/prefix/v1',
    'https://gw.example.com/v1/decision',
    'https://user:pass@gw.example.com',
    'https://gw.example.com?key=abc',
    'https://gw.example.com#frag',
  ]) {
    assert.throws(() => validatePluginConfig({ ...baseConfig, baseUrl }), /baseUrl/, baseUrl)
  }
  assert.equal(validatePluginConfig({ ...baseConfig, baseUrl: 'https://gw.example.com/' }).baseUrl, 'https://gw.example.com/')
  assert.equal(
    validatePluginConfig({ ...baseConfig, baseUrl: 'https://gw.example.com/gateway' }).baseUrl,
    'https://gw.example.com/gateway',
  )
})

test('model 必须显式配置且不能为 auto，apiKeyEnv 必须是合法环境变量名', () => {
  assert.throws(() => validatePluginConfig({ ...baseConfig, model: undefined }), /model 必须显式配置/)
  assert.throws(() => validatePluginConfig({ ...baseConfig, model: '  ' }), /model 必须显式配置/)
  assert.throws(() => validatePluginConfig({ ...baseConfig, model: 'auto' }), /auto/)
  assert.throws(() => validatePluginConfig({ ...baseConfig, model: 'AUTO' }), /auto/)
  const config = validatePluginConfig(baseConfig)
  assert.equal(config.model, 'decision-model')
  assert.equal(config.apiKeyEnv, 'DECISION_API_KEY')
  assert.throws(() => validatePluginConfig({ ...baseConfig, apiKeyEnv: 'not-an-env-name!' }), /apiKeyEnv/)
})

test('只接受 off、shadow 和 advisory 模式', () => {
  assert.throws(() => validatePluginConfig({ ...baseConfig, mode: 'enforced' }), /mode/)
})

test('abstainBelow 必须在 0 到 1 且不高于 minConfidence', () => {
  assert.throws(() => validatePluginConfig({ ...baseConfig, abstainBelow: -0.1 }), /abstainBelow/)
  assert.throws(() => validatePluginConfig({ ...baseConfig, abstainBelow: 1.1 }), /abstainBelow/)
  assert.throws(() => validatePluginConfig({ ...baseConfig, abstainBelow: 0.9 }), /abstainBelow/)
  const config = validatePluginConfig({ ...baseConfig, abstainBelow: 0.5 })
  assert.equal(config.abstainBelow, 0.5)
})

test('接受通用实质决策、实体候选和查询计划复核决策点', () => {
  const points = [
    'selection_review',
    'entity_resolution',
    'plan_consistency_review',
  ]
  const config = validatePluginConfig({ ...baseConfig, allowedDecisionPoints: points })
  assert.deepEqual(config.allowedDecisionPoints, points)
})

test('接受任意合法命名的决策点', () => {
  const config = validatePluginConfig({ ...baseConfig, allowedDecisionPoints: ['custom_review_point'] })
  assert.deepEqual(config.allowedDecisionPoints, ['custom_review_point'])
})

test('拒绝不符合命名规则的决策点', () => {
  assert.throws(
    () => validatePluginConfig({ ...baseConfig, allowedDecisionPoints: ['Bad Point'] }),
    /allowedDecisionPoints/,
  )
})

test('规范化合法决策输入并保留独立主模型预选', () => {
  const input = normalizeDecisionInput(baseInput, baseConfig)
  assert.equal(input.primaryChoice, 'metric_a')
  assert.deepEqual(input.optionIds, ['metric_a', 'metric_b'])
})

test('拒绝白名单外的决策点', () => {
  assert.throws(
    () => normalizeDecisionInput({ ...baseInput, point: 'permission_check' }, baseConfig),
    (error) => error instanceof DecisionInputError && error.code === 'DECISION_POINT_NOT_ALLOWED',
  )
})

test('拒绝重复候选 id', () => {
  const options = [baseInput.options[0], { ...baseInput.options[1], id: 'metric_a' }]
  assert.throws(
    () => normalizeDecisionInput({ ...baseInput, options }, baseConfig),
    (error) => error instanceof DecisionInputError && error.code === 'DUPLICATE_OPTION_ID',
  )
})

test('拒绝不在候选集中的 primaryChoice', () => {
  assert.throws(
    () => normalizeDecisionInput({ ...baseInput, primaryChoice: 'metric_c' }, baseConfig),
    (error) => error instanceof DecisionInputError && error.code === 'INVALID_PRIMARY_CHOICE',
  )
})

test('拒绝超过证据预算的输入', () => {
  const evidence = Array.from({ length: 6 }, (_, index) => ({ id: `E${index + 1}`, fact: 'x'.repeat(1100) }))
  assert.throws(
    () => normalizeDecisionInput({ ...baseInput, evidence }, baseConfig),
    (error) => error instanceof DecisionInputError && error.code === 'EVIDENCE_TOO_LARGE',
  )
})

test('拒绝疑似包含凭据的外发内容', () => {
  assert.throws(
    () => normalizeDecisionInput({ ...baseInput, question: '使用 Authorization: Bearer abcdefghijklmnop 做判断' }, baseConfig),
    (error) => error instanceof DecisionInputError && error.code === 'SENSITIVE_INPUT',
  )
})

test('构造的 decision API 请求映射 state、criteria 与 instructions', () => {
  const input = normalizeDecisionInput(baseInput, baseConfig)
  const request = buildDecisionRequest(input, { ...baseConfig, systemExtra: '' })
  assert.equal(request.model, 'decision-model')
  assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state'])
  assert.deepEqual(Object.keys(request.questions.recommendation).sort(), ['criteria', 'instructions', 'type'])
  assert.equal(request.state.point, 'candidate_selection')
  assert.equal(request.state.question, baseInput.question)
  assert.equal(request.state.primaryChoice, 'metric_a')
  assert.deepEqual(request.state.evidence, ['系统预估口径包含尚未确认的订单', '用户要求使用财务确认口径'])
  assert.deepEqual(request.state.constraints, ['只能从候选集合中选择'])
  const recommendation = request.questions.recommendation
  assert.equal(recommendation.type, 'choice')
  assert.deepEqual(recommendation.criteria, {
    metric_a: '系统预估收入',
    metric_b: '财务确认收入',
  })
  assert.match(recommendation.instructions, /证据/)
})

test('systemExtra 追加为领域约束指令', () => {
  const input = normalizeDecisionInput(baseInput, baseConfig)
  const request = buildDecisionRequest(input, { ...baseConfig, systemExtra: '优先财务口径' })
  assert.match(request.questions.recommendation.instructions, /领域约束：优先财务口径/)
})

test('严格解析 decision API choice 响应并容忍附加字段', () => {
  const result = parseDecisionResponse(
    {
      model: 'decision-model',
      answers: {
        recommendation: {
          type: 'choice',
          choice: 'metric_b',
          confidence: 0.99,
          probabilities: { metric_b: 1.0, metric_a: 0.0 },
        },
      },
      usage: { input_tokens: 396, output_tokens: 37 },
    },
    ['metric_a', 'metric_b'],
  )
  assert.deepEqual(result, {
    recommendation: 'metric_b',
    confidence: 0.99,
    probabilities: { metric_b: 1.0, metric_a: 0.0 },
    abstain: false,
    risks: [],
    missingEvidence: [],
  })
})

test('probabilities 缺失时容忍，越界键或越界值则拒绝', () => {
  const without = parseDecisionResponse(
    { answers: { recommendation: { type: 'choice', choice: 'metric_a', confidence: 0.8 } } },
    ['metric_a', 'metric_b'],
  )
  assert.equal(without?.probabilities, undefined)
  const badKey = parseDecisionResponse(
    { answers: { recommendation: { type: 'choice', choice: 'metric_a', confidence: 0.8, probabilities: { metric_c: 1 } } } },
    ['metric_a', 'metric_b'],
  )
  assert.equal(badKey, undefined)
  const badValue = parseDecisionResponse(
    { answers: { recommendation: { type: 'choice', choice: 'metric_a', confidence: 0.8, probabilities: { metric_a: 1.2 } } } },
    ['metric_a', 'metric_b'],
  )
  assert.equal(badValue, undefined)
})

test('拒绝候选集外的 choice、越界 confidence 和缺失结构', () => {
  const ok = (recommendation) => ({ answers: { recommendation } })
  assert.equal(
    parseDecisionResponse(ok({ type: 'choice', choice: 'metric_c', confidence: 0.9 }), ['metric_a', 'metric_b']),
    undefined,
  )
  assert.equal(
    parseDecisionResponse(ok({ type: 'choice', choice: 'metric_a', confidence: 1.5 }), ['metric_a', 'metric_b']),
    undefined,
  )
  assert.equal(
    parseDecisionResponse(ok({ type: 'choice', choice: 'metric_a', confidence: 'high' }), ['metric_a', 'metric_b']),
    undefined,
  )
  assert.equal(
    parseDecisionResponse(ok({ type: 'text', choice: 'metric_a', confidence: 0.9 }), ['metric_a', 'metric_b']),
    undefined,
  )
  assert.equal(parseDecisionResponse({}, ['metric_a', 'metric_b']), undefined)
  assert.equal(parseDecisionResponse('not an object', ['metric_a', 'metric_b']), undefined)
})

test('shadow 模式不向主模型暴露 DECISION 建议', () => {
  const input = normalizeDecisionInput(baseInput, { ...baseConfig, mode: 'shadow' })
  const result = projectDecisionResult(
    { recommendation: 'metric_b', confidence: 0.91, abstain: false, risks: [], missingEvidence: [] },
    input,
    { ...baseConfig, mode: 'shadow' },
  )
  assert.equal(result.status, 'shadow')
  assert.equal(result.primaryChoice, 'metric_a')
  assert.equal('recommendation' in result, false)
  assert.equal(result.adoptable, false)
})

test('advisory 仅在达到置信度时可采纳', () => {
  const input = normalizeDecisionInput(baseInput, baseConfig)
  const high = projectDecisionResult(
    { recommendation: 'metric_b', confidence: 0.91, abstain: false, risks: [], missingEvidence: [] },
    input,
    baseConfig,
  )
  const low = projectDecisionResult(
    { recommendation: 'metric_b', confidence: 0.6, abstain: false, risks: [], missingEvidence: [] },
    input,
    baseConfig,
  )
  assert.equal(high.status, 'ok')
  assert.equal(high.adoptable, true)
  assert.equal(high.recommendation, 'metric_b')
  assert.equal(high.confidence, 0.91)
  assert.equal(high.abstain, false)
  assert.equal(low.status, 'not_adoptable')
  assert.equal(low.reasonCode, 'low_confidence')
  assert.equal(low.adoptable, false)
  assert.equal(low.recommendation, 'metric_b')
  assert.deepEqual(low.probabilities, undefined)
})

test('置信度低于 abstainBelow 时判为弃权，不透出候选建议', () => {
  const input = normalizeDecisionInput(baseInput, baseConfig)
  const result = projectDecisionResult(
    { recommendation: 'metric_b', confidence: 0.3, abstain: false, risks: [], missingEvidence: [] },
    input,
    baseConfig,
  )
  assert.equal(result.status, 'abstained')
  assert.equal(result.reasonCode, 'insufficient_evidence')
  assert.equal(result.abstain, true)
  assert.equal(result.confidence, 0.3)
  assert.equal(result.adoptable, false)
  assert.equal('recommendation' in result, false)
})

test('advisory 透传 probabilities 供主模型参考', () => {
  const input = normalizeDecisionInput(baseInput, baseConfig)
  const result = projectDecisionResult(
    { recommendation: 'metric_b', confidence: 0.91, probabilities: { metric_a: 0, metric_b: 1 }, abstain: false, risks: [], missingEvidence: [] },
    input,
    baseConfig,
  )
  assert.deepEqual(result.probabilities, { metric_a: 0, metric_b: 1 })
})
