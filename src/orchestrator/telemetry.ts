/**
 * W&B Weave OpenTelemetry wiring.
 *
 * When `WANDB_API_KEY` is set, derive the OpenCode OTEL env vars the
 * `@devtheops/opencode-plugin-otel` plugin reads, targeting W&B Weave. W&B
 * requires HTTP Basic auth (`base64("api:" + key)`) plus a `project_id` header
 * (`<entity>/<project>`) — a plain `wandb-api-key` header does NOT route traces.
 *
 * Other OTLP backends: leave `WANDB_API_KEY` unset and set the `OPENCODE_OTLP_*`
 * vars yourself; this function then does nothing.
 */
export function configureWandbOtel(): void {
  const key = process.env.WANDB_API_KEY
  if (!key) return

  const auth = Buffer.from(`api:${key}`).toString("base64")
  const headers = [`Authorization=Basic ${auth}`]
  const project = process.env.WANDB_PROJECT_ID
  if (project) headers.push(`project_id=${project}`)

  process.env.OPENCODE_ENABLE_TELEMETRY = "1"
  process.env.OPENCODE_OTLP_PROTOCOL = "http/protobuf"
  // Base URL; the plugin appends /v1/traces for http/protobuf.
  process.env.OPENCODE_OTLP_ENDPOINT = "https://trace.wandb.ai/otel"
  process.env.OPENCODE_OTLP_HEADERS = headers.join(",")
}
