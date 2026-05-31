import { startWandbBridge, type WandbBridge } from "./wandbBridge"

/**
 * W&B Weave OpenTelemetry wiring.
 *
 * W&B's OTLP endpoint only accepts protobuf, but the OpenCode OTEL plugin emits
 * OTLP/JSON. So when `WANDB_API_KEY` is set we start a local JSON→protobuf bridge
 * ([[wandbBridge]]) and point the plugin's OTLP env at it; the bridge forwards
 * to W&B with Basic auth + `project_id`.
 *
 * Returns the bridge (so the caller can close it after the export flushes), or
 * undefined when telemetry is not configured. The key is sanitized of stray
 * whitespace / a trailing ';' (a common copy-paste artifact that silently breaks
 * auth). Other OTLP backends: leave WANDB_API_KEY unset and set OPENCODE_OTLP_*
 * yourself.
 */
export function startWandbTelemetry(): WandbBridge | undefined {
  const key = (process.env.WANDB_API_KEY ?? "").trim().replace(/;+$/, "")
  if (!key) return undefined

  const bridge = startWandbBridge({ apiKey: key, projectId: process.env.WANDB_PROJECT_ID })
  process.env.OPENCODE_ENABLE_TELEMETRY = "1"
  process.env.OPENCODE_OTLP_PROTOCOL = "http/protobuf"
  process.env.OPENCODE_OTLP_ENDPOINT = bridge.endpoint
  return bridge
}
