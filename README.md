# dsh-decision-review

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets the primary
model ask a second, independent model to review a decision it has already formed.

The primary model produces `primaryChoice` first. The reviewer only sees the question, that choice,
its evidence, and the allowed constraints. The primary model remains the decision maker: it may
adopt the suggestion, keep its own choice, or ask the user.

## Install

```sh
dsh plugin --profile <name> add dsh-decision-review
```

The bundle installs with `mode: off`. Enable it in the profile's patch layer:

```yaml
- insert:
    - id: decision-review
      name: dsh-decision-review
      config:
        mode: advisory
        model: your-decision-model
        baseUrl: https://your-gateway
```

The reviewer endpoint (`POST /v1/decision`) is not provided by this package; without a compatible
service, keep `mode: off`. Requires a DSH build exposing `ctx.tools` and `ctx.logger` (0.2.x).

## Requirements

- Node.js 20.11+
- `@deepseek-ai/schemastery` 3.18.2

Entry point: `src/decision-model.mjs`

Tool name: `__decision_review`

## Protocol

The reviewer endpoint is a structured decision API, not an OpenAI-compatible chat endpoint:

```text
POST {baseUrl}/v1/decision
Authorization: Bearer {DECISION_API_KEY}
```

The request body has exactly three top-level fields, `{ model, state, questions }`. The plugin maps
`question`, `primaryChoice`, `evidence`, and `constraints` into `state`, turns the candidate list
into `questions.recommendation.criteria`, and reads `choice` plus `confidence` from
`answers.recommendation`.

- `baseUrl` (or `DECISION_BASE_URL`) is the gateway root, without `/v1`. The plugin appends the
  path itself; an address that already ends in `/v1` or in the endpoint path is rejected at startup.
- `apiKeyEnv` names the environment variable holding the credential. It defaults to
  `DECISION_API_KEY`; credentials are never read from the repository or from profile files.
- `model` is required and has no default.
- `probabilities` are passed through to the primary model for reference and never take part in the
  decision.
- The gateway is not retried automatically, and neither is the plugin. On failure the primary
  model's own judgment stands.

## Confidence

- `confidence >= minConfidence`: `ok`, the suggestion is adoptable.
- `abstainBelow <= confidence < minConfidence`: `not_adoptable`, the suggestion is kept but does
  not clear the bar.
- `confidence < abstainBelow`: `abstained`, treated as insufficient evidence and not surfaced.

`abstainBelow` defaults to 0.5, `minConfidence` to 0.75, and `abstainBelow` may not exceed
`minConfidence`.

## Modes

- `off`: neither the prompt section nor the tool is registered.
- `shadow`: the review runs and logs, but no suggestion reaches the primary model.
- `advisory`: a structured suggestion is returned and the primary model decides what to do with it.

## Configuration

```yaml
- insert:
    - id: decision-review
      name: /opt/dsh/plugins/decision-review/src/decision-model.mjs
      config:
        mode: advisory
        model: your-decision-model
        allowedDecisionPoints:
          - custom_review_point
        timeoutMs: 5000
        minConfidence: 0.75
        abstainBelow: 0.5
        promptSection: true
        promptSectionOrder: 30
```

`allowedDecisionPoints` is a list of decision point names. Any name matching
`^[a-z0-9][a-z0-9._-]*$` is accepted; the list simply narrows what the host may ask.

Permissions, approvals, user confirmation, write operations, network targets, and tool allowlists
must never be delegated to the reviewer.

## Failure codes

| reasonCode | Meaning |
| --- | --- |
| `timeout` / `cancelled` | Local timeout or the parent request was cancelled |
| `upstream_timeout` | The gateway reported an upstream timeout (HTTP 504) |
| `credential_unavailable` | The credential environment variable is missing |
| `authentication_failed` | The credential is missing or rejected (HTTP 401) |
| `model_not_authorized` | The model is not authorized for this credential (HTTP 403) |
| `model_unsupported` | The model name is unknown to the gateway |
| `invalid_request` | The gateway rejected the request body (HTTP 400) |
| `route_unavailable` | HTTP 404; check that `baseUrl` is the gateway root |
| `rate_limited` / `quota_exceeded` | Upstream rate limit or exhausted budget |
| `context_too_large` | HTTP 413 |
| `invalid_response` / `response_too_large` | The response cannot be parsed or exceeds its bound |
| `provider_error` | Any other network or server failure |

Logs go through the host logger under `decision-review` and record the point, status, reason code,
model, HTTP status, gateway code, request id, input size fingerprint, and latency. Request content
and raw gateway errors are never logged.

## Test

```sh
npm install --include=dev
npm test
npm run check
```

## License

MIT
