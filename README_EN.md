<div align="center">
  <h1>dsh-decision-review</h1>
  <p><strong>The primary model keeps deciding; a second model only advises.</strong></p>
  <p>Independent review as a DeepSeek Harness tool, not a replacement for the decision maker.</p>

  <p>
    <img src="https://img.shields.io/badge/node-%3E%3D20.11-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20.11+" />
    <img src="https://img.shields.io/badge/DSH-0.2.x-4D6BFE?style=flat-square" alt="DSH 0.2.x" />
    <img src="https://img.shields.io/badge/tests-73%20passed-brightgreen?style=flat-square" alt="73 tests passed" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License" /></a>
  </p>

  <p><a href="README.md">简体中文</a> · English</p>
</div>

> [!NOTE]
> This bundle installs with `mode: off` and makes no calls. Enabling it requires a compatible
> `POST /v1/decision` service plus an explicit `model` and `baseUrl`.

## Why this plugin

Asking one model to check its own answer usually repeats its own reasoning. A second opinion is
useful only when the reviewer sees the question, the primary choice, the evidence, and the
constraints without joining the original reasoning or holding tool permissions.

The primary model must commit to `primaryChoice` before review starts. The suggestion and its
confidence return to the primary model, which still decides whether to adopt, keep, or ask the user.

```mermaid
flowchart LR
    A[Primary model picks primaryChoice] --> B[__decision_review tool]
    B --> C[POST /v1/decision]
    C --> D[choice + confidence]
    D --> E{confidence}
    E -->|>= minConfidence| F[ok: adoptable]
    E -->|>= abstainBelow| G[not_adoptable]
    E -->|< abstainBelow| H[abstained]
    F --> I[Primary model decides]
    G --> I
    H --> I
```

## Capabilities

| Capability | Behaviour |
| --- | --- |
| Three modes | `off` registers nothing; `shadow` logs only; `advisory` returns a suggestion |
| No decision hijack | Review returns advice and confidence; the primary model still chooses |
| Structured output | `status`, `recommendation.choice`, `confidence`, `reasonCode` |
| Confidence tiers | Adoptable, keep-but-not-recommended, or abstained |
| No retries | A failed review returns immediately; the primary judgement stands |
| Redacted logs | Point, status, reason code, model, HTTP status, request id, input fingerprint, latency |
| Observability | One stderr line per review with `traceparent` tracing; failures distinguish "no response headers yet" from "reading the body" |
| Permission isolation | Permissions, approvals, writes, network targets, and allowlists never reach the reviewer |

## Protocol

```text
POST {baseUrl}/v1/decision
Authorization: Bearer {DECISION_API_KEY}
```

The body has exactly three top-level fields: `{ model, state, questions }`.

| Field | Source |
| --- | --- |
| `state.question` | Tool input `question` |
| `state.primaryChoice` | Tool input `primaryChoice` |
| `state.evidence` | Tool input `evidence` |
| `state.constraints` | Tool input `constraints` |
| `questions.recommendation.criteria` | Tool input `options` |
| Response | `answers.recommendation.choice` and `confidence` |

`probabilities` are informational only. `baseUrl` is the gateway root; an address already ending in
`/v1` or the endpoint path is rejected at startup.

## Install

```sh
dsh plugin --profile <name> add dsh-decision-review
dsh plugin --profile <name> add /path/to/dsh-decision-review
dsh plugin --profile <name> add github:ninetyhe-90/dsh-decision-review
```

## Configuration

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `off` \| `shadow` \| `advisory` | `off` | Run mode |
| `model` | `string` | none | Required reviewer model name |
| `baseUrl` | `string` | empty | Reviewer gateway root, without `/v1` |
| `apiKeyEnv` | `string` | `DECISION_API_KEY` | Environment variable holding the credential |
| `allowedDecisionPoints` | `string[]` | `[]` | Decision point names allowed to call review |
| `timeoutMs` | `number` | `5000` | Per-review timeout |
| `minConfidence` | `number` | `0.75` | Adoptable threshold |
| `abstainBelow` | `number` | `0.5` | Abstain threshold |
| `promptSection` | `boolean` | `true` | Inject the prompt section |
| `promptSectionOrder` | `number` | `30` | Prompt section order |
| `systemExtra` | `string` | empty | Extra domain constraints |
| `requestIdFile` | `string` | empty | Optional file the host writes per turn; its content becomes `requestId` in logs for correlation |

```yaml
- insert:
    - id: decision-review
      name: dsh-decision-review
      config:
        mode: advisory
        model: your-decision-model
        baseUrl: https://your-gateway
```

## Failure codes

| `reasonCode` | Meaning |
| --- | --- |
| `timeout` / `cancelled` | Local timeout or parent request cancelled |
| `upstream_timeout` | Upstream timeout reported by the gateway (HTTP 504) |
| `credential_unavailable` | Credential environment variable missing |
| `authentication_failed` | Credential missing or rejected (HTTP 401) |
| `model_not_authorized` | Credential cannot use the model (HTTP 403) |
| `model_unsupported` | Gateway does not know the model |
| `invalid_request` | Request body rejected (HTTP 400) |
| `route_unavailable` | HTTP 404; check `baseUrl` |
| `rate_limited` / `quota_exceeded` | Upstream limit or exhausted budget |
| `context_too_large` | HTTP 413 |
| `invalid_response` / `response_too_large` | Unparsable or oversized response |
| `provider_error` | Any other network or server failure |

## Logging and diagnostics

Review events go through the host logger named `decision-review`, and the plugin also registers an
exporter that writes one line per event to stderr:

```text
DECISION_REVIEW {"level":"info","msg":"decision review","status":"unavailable","reasonCode":"timeout","requestId":"64d1c9b1-...","toolCallId":"call_...","latencyMs":10012,...}
```

- The exporter declares `levels` as `{ 'decision-review': 2, default: -1 }`; without it cordis
  filters at the INFO threshold and drops warn, while `default: -1` keeps other plugins' logs out.
  When the host has no `ctx.logger.exporter`, the export is skipped and everything else still works.
- One line per success, per failure, and per rejected input; fields match the logger event and never
  contain request content, candidate descriptions, or credentials.
- Every review sends a W3C `traceparent` and logs its `traceId`. A timed-out call returns no response,
  so no HTTP status exists and `traceId` is the only thing to reconcile against the gateway. When the
  gateway echoes `x-platform-trace-id` / `x-trace-context-status`, they are logged as
  `platformTraceId` / `traceContextStatus`; matching `traceId` with a status other than `generated`
  means the gateway adopted the trace.
- Failure lines carry `stage`: `request` means the call never received response headers (connect,
  queue, and model inference all live there), `response_body` means headers arrived and the body was
  being read. Header arrival adds `headersMs`, timeouts add `timeoutMs`, and network failures add the
  error class name `errorName` plus `errorCode` (for example `ECONNRESET`) without the message.
- Rejected input carries `field` (such as `options[1].description`) and `actualType` (such as
  `undefined` or `object`) — a fixed field path and a type name only; the text returned to the primary
  model repeats the field path so a corrected retry is possible.
- DSH does not validate `parameters`, but host hooks, approvals, and guards can reject a call before
  `execute`, and non-input exceptions or output-schema failures inside `execute` never reach the review
  log. The plugin subscribes to `tools/result` and appends a warn line `decision review tool failed`
  for every `isError` receipt of this tool: `stage` is `before_execute`, `execute`, or `after_execute`,
  `errorCode` comes from the error info code, and `summary` is the first line of the error text
  (`Error: ` stripped, 200 characters at most, whole line `[redacted]` when it looks like a credential).
- An outer process only needs to read stderr line by line and match the `DECISION_REVIEW ` prefix.

## Security boundaries

- The reviewer receives no tools, files, network access, or approval rights.
- Privilege escalation, user confirmation, writes, network targets, and allowlists stay outside review.
- Review output is advice; it cannot bypass the primary model or host confirmation.
- Logs omit request bodies and raw errors.

## Compatibility

- Node.js 20.11+
- DeepSeek Harness 0.2.x (`ctx.tools`, `ctx.logger`; optional `ctx.systemPrompt`; without
  `ctx.logger.exporter` or `ctx.on`, stderr logging and `tools/result` failure logging are skipped)
- `@deepseek-ai/schemastery` 3.18.x

## Layout

```text
src/decision-core.mjs    config validation, input normalisation, prompt section, reason codes
src/decision-model.mjs   tool registration, review request, result mapping
test/                    config, protocol, and tool behaviour
cordis.patch.yml         bundle layer, mode: off
```

## Development

```sh
npm install --include=dev
npm test
npm run check
```

## Roadmap

- [x] Three modes and confidence tiers
- [x] Structured failure codes and redacted logs
- [x] Per-line stderr logs, `traceparent` tracing, and failure stages
- [x] Configurable decision point allowlist
- [x] Bundle packaging
- [ ] npm release
- [ ] Minimal reference reviewer service

## License

MIT
