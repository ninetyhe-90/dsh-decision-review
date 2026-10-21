const MODES = new Set(['off', 'shadow', 'advisory'])
const POINT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_API_KEY_ENV = 'DECISION_API_KEY'
const BASE_URL_ENV = 'DECISION_BASE_URL'
export const DECISION_PATH = '/v1/decision'
const SENSITIVE_TEXT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bauthorization\s*:\s*bearer\s+\S+/i,
  /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
]

const LIMITS = Object.freeze({
  point: 64,
  route: 128,
  baseUrl: 256,
  apiKeyEnv: 64,
  allowedDecisionPoints: 8,
  question: 500,
  options: 8,
  optionId: 64,
  optionDescription: 500,
  evidenceItems: 12,
  evidenceFact: 1200,
  evidenceTotal: 6000,
  constraints: 10,
  constraint: 500,
  constraintsTotal: 2500,
})

export class DecisionInputError extends TypeError {
  constructor(code, message) {
    super(message)
    this.name = 'DecisionInputError'
    this.code = code
  }
}

function requirePlainObject(value, code, field) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new DecisionInputError(code, `${field} 必须是普通对象`)
  }
  return value
}

function containsSensitiveText(value) {
  return SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value))
}

function requireString(value, field, maxLength, pattern) {
  if (typeof value !== 'string') {
    throw new DecisionInputError('INVALID_STRING', `${field} 必须是字符串`)
  }
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new DecisionInputError('INVALID_STRING_LENGTH', `${field} 长度必须在 1 到 ${maxLength} 之间`)
  }
  if (pattern !== undefined && !pattern.test(normalized)) {
    throw new DecisionInputError('INVALID_STRING_FORMAT', `${field} 格式不合法`)
  }
  return normalized
}

function optionalStringArray(value, field, maxItems, maxItemLength, totalLimit) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new DecisionInputError('INVALID_ARRAY', `${field} 数量不能超过 ${maxItems}`)
  }
  const normalized = value.map((item, index) => requireString(item, `${field}[${index}]`, maxItemLength))
  if (normalized.reduce((sum, item) => sum + item.length, 0) > totalLimit) {
    throw new DecisionInputError('ARRAY_TOO_LARGE', `${field} 超过总字符预算 ${totalLimit}`)
  }
  return normalized
}

export function validatePluginConfig(rawConfig = {}) {
  const mode = rawConfig.mode ?? 'off'
  if (!MODES.has(mode)) {
    throw new TypeError('mode 必须是 off、shadow 或 advisory')
  }
  if (mode === 'off') return { mode }

  const configuredBaseUrl = typeof rawConfig.baseUrl === 'string' ? rawConfig.baseUrl.trim() : ''
  const rawBaseUrl = configuredBaseUrl || process.env[BASE_URL_ENV] || ''
  const baseUrl = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim() : ''
  if (baseUrl.length === 0 || baseUrl.length > LIMITS.baseUrl) {
    throw new TypeError(`baseUrl 必须显式配置或通过 ${BASE_URL_ENV} 环境变量提供`)
  }
  let parsedBaseUrl
  try {
    parsedBaseUrl = new URL(baseUrl)
  } catch {
    throw new TypeError('baseUrl 必须是合法 URL')
  }
  if (parsedBaseUrl.protocol !== 'https:' && parsedBaseUrl.protocol !== 'http:') {
    throw new TypeError('baseUrl 必须使用 http 或 https 协议')
  }
  if (parsedBaseUrl.username !== '' || parsedBaseUrl.password !== '') {
    throw new TypeError('baseUrl 不能内嵌凭据，凭据只能通过 apiKeyEnv 指定的环境变量提供')
  }
  if (parsedBaseUrl.search !== '' || parsedBaseUrl.hash !== '') {
    throw new TypeError('baseUrl 不能包含查询参数或片段')
  }
  // 插件自行拼接 /v1/decision；按 OpenAI 惯例填成 .../v1 会请求到 /v1/v1/decision 并只得到 404。
  const basePath = parsedBaseUrl.pathname.replace(/\/+$/, '')
  if (/\/v1$/i.test(basePath) || /\/decision$/i.test(basePath)) {
    throw new TypeError(`baseUrl 应为根地址，不要包含 /v1 或 /decision：插件会自行拼接 ${DECISION_PATH}`)
  }

  const apiKeyEnv = rawConfig.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length > LIMITS.apiKeyEnv || !ENV_NAME_PATTERN.test(apiKeyEnv)) {
    throw new TypeError('apiKeyEnv 必须是合法的环境变量名')
  }

  const model = typeof rawConfig.model === 'string' ? rawConfig.model.trim() : ''
  if (model.length === 0) {
    throw new TypeError('model 必须显式配置：网关只接受注册表内的决策模型名（如 decision-model），插件不提供默认值')
  }
  if (model.length > LIMITS.route || !ROUTE_PATTERN.test(model)) {
    throw new TypeError(`model 必须是长度不超过 ${LIMITS.route} 的合法模型名`)
  }
  if (model.toLowerCase() === 'auto') {
    throw new TypeError('model 不能为 auto：decision API 端点要求显式指定决策模型')
  }

  if (
    !Array.isArray(rawConfig.allowedDecisionPoints)
    || rawConfig.allowedDecisionPoints.length === 0
    || rawConfig.allowedDecisionPoints.length > LIMITS.allowedDecisionPoints
  ) {
    throw new TypeError(`allowedDecisionPoints 数量必须在 1 到 ${LIMITS.allowedDecisionPoints} 之间`)
  }
  const allowedDecisionPoints = rawConfig.allowedDecisionPoints.map((point, index) =>
    requireString(point, `allowedDecisionPoints[${index}]`, LIMITS.point, POINT_PATTERN),
  )
  if (new Set(allowedDecisionPoints).size !== allowedDecisionPoints.length) {
    throw new TypeError('allowedDecisionPoints 不能重复')
  }

  const timeoutMs = rawConfig.timeoutMs ?? 5000
  const minConfidence = rawConfig.minConfidence ?? 0.75
  const abstainBelow = rawConfig.abstainBelow ?? 0.5
  const promptSection = rawConfig.promptSection ?? true
  const promptSectionOrder = rawConfig.promptSectionOrder ?? 30
  const systemExtra = rawConfig.systemExtra ?? ''

  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
    throw new TypeError('timeoutMs 必须是 100 到 10000 之间的整数')
  }
  if (typeof minConfidence !== 'number' || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new TypeError('minConfidence 必须是 0 到 1 之间的数字')
  }
  if (typeof abstainBelow !== 'number' || !Number.isFinite(abstainBelow) || abstainBelow < 0 || abstainBelow > 1) {
    throw new TypeError('abstainBelow 必须是 0 到 1 之间的数字')
  }
  if (abstainBelow > minConfidence) {
    throw new TypeError('abstainBelow 不能高于 minConfidence，否则永远无法产出可采纳建议')
  }
  if (typeof promptSection !== 'boolean') throw new TypeError('promptSection 必须是布尔值')
  if (!Number.isFinite(promptSectionOrder)) throw new TypeError('promptSectionOrder 必须是数字')
  if (typeof systemExtra !== 'string' || systemExtra.length > 4000) {
    throw new TypeError('systemExtra 必须是不超过 4000 字符的字符串')
  }

  return Object.freeze({
    mode,
    baseUrl,
    apiKeyEnv,
    model,
    allowedDecisionPoints: Object.freeze(allowedDecisionPoints),
    timeoutMs,
    minConfidence,
    abstainBelow,
    promptSection,
    promptSectionOrder,
    systemExtra: systemExtra.trim(),
  })
}

export function normalizeDecisionInput(rawInput, rawConfig) {
  const config = validatePluginConfig(rawConfig)
  if (config.mode === 'off') {
    throw new DecisionInputError('PLUGIN_OFF', 'DECISION 插件未启用')
  }
  const input = requirePlainObject(rawInput, 'INVALID_INPUT', 'input')
  const point = requireString(input.point, 'point', LIMITS.point, POINT_PATTERN)
  if (!config.allowedDecisionPoints.includes(point)) {
    throw new DecisionInputError('DECISION_POINT_NOT_ALLOWED', `决策点 ${point} 不在允许列表中`)
  }
  const question = requireString(input.question, 'question', LIMITS.question)
  const primaryChoice = requireString(input.primaryChoice, 'primaryChoice', LIMITS.optionId, ID_PATTERN)

  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > LIMITS.options) {
    throw new DecisionInputError('INVALID_OPTIONS', `options 数量必须在 2 到 ${LIMITS.options} 之间`)
  }
  const options = input.options.map((rawOption, index) => {
    const option = requirePlainObject(rawOption, 'INVALID_OPTION', `options[${index}]`)
    const id = requireString(option.id, `options[${index}].id`, LIMITS.optionId, ID_PATTERN)
    const description = requireString(
      option.description,
      `options[${index}].description`,
      LIMITS.optionDescription,
    )
    const evidenceRefs = optionalStringArray(
      option.evidenceRefs,
      `options[${index}].evidenceRefs`,
      LIMITS.evidenceItems,
      LIMITS.optionId,
      LIMITS.evidenceItems * LIMITS.optionId,
    )
    return { id, description, evidenceRefs }
  })
  const optionIds = options.map((option) => option.id)
  if (new Set(optionIds).size !== optionIds.length) {
    throw new DecisionInputError('DUPLICATE_OPTION_ID', '候选 id 不能重复')
  }
  if (!optionIds.includes(primaryChoice)) {
    throw new DecisionInputError('INVALID_PRIMARY_CHOICE', 'primaryChoice 必须属于候选集合')
  }

  if (input.evidence !== undefined && !Array.isArray(input.evidence)) {
    throw new DecisionInputError('INVALID_EVIDENCE', 'evidence 必须是数组')
  }
  const rawEvidence = input.evidence ?? []
  if (rawEvidence.length > LIMITS.evidenceItems) {
    throw new DecisionInputError('EVIDENCE_TOO_LARGE', `evidence 数量不能超过 ${LIMITS.evidenceItems}`)
  }
  const evidence = rawEvidence.map((rawItem, index) => {
    const item = requirePlainObject(rawItem, 'INVALID_EVIDENCE', `evidence[${index}]`)
    return {
      id: requireString(item.id, `evidence[${index}].id`, LIMITS.optionId, ID_PATTERN),
      fact: requireString(item.fact, `evidence[${index}].fact`, LIMITS.evidenceFact),
    }
  })
  const evidenceIds = evidence.map((item) => item.id)
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new DecisionInputError('DUPLICATE_EVIDENCE_ID', '证据 id 不能重复')
  }
  if (evidence.reduce((sum, item) => sum + item.fact.length, 0) > LIMITS.evidenceTotal) {
    throw new DecisionInputError('EVIDENCE_TOO_LARGE', `evidence 超过总字符预算 ${LIMITS.evidenceTotal}`)
  }
  const evidenceIdSet = new Set(evidenceIds)
  for (const option of options) {
    for (const ref of option.evidenceRefs) {
      if (!evidenceIdSet.has(ref)) {
        throw new DecisionInputError('UNKNOWN_EVIDENCE_REF', `候选 ${option.id} 引用了不存在的证据 ${ref}`)
      }
    }
  }

  const constraints = optionalStringArray(
    input.constraints,
    'constraints',
    LIMITS.constraints,
    LIMITS.constraint,
    LIMITS.constraintsTotal,
  )

  const outboundText = [
    question,
    ...options.map((option) => option.description),
    ...evidence.map((item) => item.fact),
    ...constraints,
  ]
  if (outboundText.some(containsSensitiveText)) {
    throw new DecisionInputError('SENSITIVE_INPUT', '决策输入疑似包含凭据或密钥，禁止发送到 DECISION')
  }

  return Object.freeze({
    point,
    question,
    primaryChoice,
    options,
    optionIds: Object.freeze(optionIds),
    evidence,
    constraints,
  })
}

const BASE_INSTRUCTIONS = [
  '根据 state 中的 question、evidence 与 constraints 评估 criteria 中的候选，选择证据最充分的选项。',
  '约束和可验证证据优先于偏好；不得根据候选顺序选择。',
  '证据不足以区分候选时保持低置信度。',
].join('')

export function buildDecisionRequest(input, config) {
  const instructions = config.systemExtra === ''
    ? BASE_INSTRUCTIONS
    : `${BASE_INSTRUCTIONS} 领域约束：${config.systemExtra}`
  return {
    state: {
      point: input.point,
      question: input.question,
      primaryChoice: input.primaryChoice,
      evidence: input.evidence.map((item) => item.fact),
      constraints: input.constraints,
    },
    model: config.model,
    questions: {
      recommendation: {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(input.options.map((option) => [option.id, option.description])),
      },
    },
  }
}

export function parseDecisionResponse(value, optionIds) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const answers = value.answers
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return undefined
  const recommendation = answers.recommendation
  if (recommendation === null || typeof recommendation !== 'object' || Array.isArray(recommendation)) return undefined
  if (recommendation.type !== 'choice') return undefined
  if (typeof recommendation.choice !== 'string') return undefined
  const choice = recommendation.choice.trim()
  if (choice.length === 0 || !optionIds.includes(choice)) return undefined
  const confidence = recommendation.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return undefined
  }
  let probabilities
  if (recommendation.probabilities !== undefined) {
    const rawProbabilities = recommendation.probabilities
    if (rawProbabilities === null || typeof rawProbabilities !== 'object' || Array.isArray(rawProbabilities)) {
      return undefined
    }
    probabilities = {}
    for (const [key, value] of Object.entries(rawProbabilities)) {
      if (!optionIds.includes(key)) return undefined
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined
      probabilities[key] = value
    }
  }
  return {
    recommendation: choice,
    confidence,
    probabilities,
    abstain: false,
    risks: [],
    missingEvidence: [],
  }
}

export function projectDecisionResult(decision, input, rawConfig) {
  const config = validatePluginConfig(rawConfig)
  if (config.mode === 'shadow') {
    return {
      status: 'shadow',
      mode: 'shadow',
      point: input.point,
      primaryChoice: input.primaryChoice,
      adoptable: false,
    }
  }

  if (decision.confidence < config.abstainBelow) {
    return {
      status: 'abstained',
      mode: 'advisory',
      point: input.point,
      primaryChoice: input.primaryChoice,
      confidence: decision.confidence,
      risks: decision.risks,
      missingEvidence: decision.missingEvidence,
      abstain: true,
      reasonCode: 'insufficient_evidence',
      adoptable: false,
    }
  }

  const adoptable = decision.confidence >= config.minConfidence
  return {
    status: adoptable ? 'ok' : 'not_adoptable',
    mode: 'advisory',
    point: input.point,
    primaryChoice: input.primaryChoice,
    recommendation: decision.recommendation,
    confidence: decision.confidence,
    ...(decision.probabilities === undefined ? {} : { probabilities: decision.probabilities }),
    risks: decision.risks,
    missingEvidence: decision.missingEvidence,
    abstain: false,
    ...(adoptable ? {} : { reasonCode: 'low_confidence' }),
    adoptable,
  }
}

export const decisionLimits = LIMITS
