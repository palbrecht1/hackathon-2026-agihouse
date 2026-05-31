import { createOpencode } from "@opencode-ai/sdk"
import type { Config } from "@opencode-ai/sdk"
import type { PromptClient } from "./run"
import { buildAgentConfig } from "../opencode/agents"
import { configureWandbOtel } from "./telemetry"
import type { Rule } from "../config/schema"

export interface SdkHandle {
  client: PromptClient
  close: () => Promise<void>
}

/** OpenCode plugin that exports OTEL traces/metrics (e.g. to W&B Weave). */
const OTEL_PLUGIN = "@devtheops/opencode-plugin-otel"

/**
 * After the review finishes we must keep the (spawned) OpenCode server alive
 * briefly so the OTEL BatchSpanProcessor flushes queued spans before we close
 * it — otherwise a short-lived run exports nothing. Paired with a short batch
 * schedule delay below.
 */
const TELEMETRY_FLUSH_GRACE_MS = 3000

/**
 * Turn an OpenCode event into a one-line activity log, or null to skip.
 * The orchestrator's work surfaces as `message.part.updated` events whose part
 * is a `subtask` (a dispatched rule-reviewer) or a `tool` call (e.g. the task or
 * report tool). This gives realtime visibility into what the agents are doing.
 */
function describeEvent(ev: { type: string; properties?: Record<string, unknown> }): string | null {
  if (ev.type === "session.error") {
    return `⚠️  session error: ${JSON.stringify(ev.properties?.error ?? ev.properties)}`
  }
  if (ev.type !== "message.part.updated") return null
  const part = (ev.properties?.part ?? {}) as Record<string, unknown>
  if (part.type === "subtask") {
    return `↳ dispatched subagent [${String(part.agent)}]: ${String(part.description)}`
  }
  if (part.type === "tool") {
    const status = String((part.state as { status?: string } | undefined)?.status ?? "")
    if (status === "running" || status === "completed" || status === "error") {
      return `  🔧 ${String(part.tool)} (${status})`
    }
  }
  return null
}

/** A stable per-event key so each subtask/tool transition logs at most once. */
function eventKey(ev: { type: string; properties?: Record<string, unknown> }): string {
  const part = (ev.properties?.part ?? {}) as Record<string, unknown>
  const status = (part.state as { status?: string } | undefined)?.status ?? ""
  return `${ev.type}:${String(part.type ?? "")}:${String(part.callID ?? part.description ?? "")}:${String(status)}`
}

/**
 * Subscribe to the global event stream and log agent activity to stdout. Uses
 * `.catch` rather than try/catch (the codebase's own neverthrow rule). The loop
 * ends when the server closes the stream.
 */
function startEventLogger(client: { event: { subscribe: () => Promise<{ stream: AsyncIterable<unknown> }> } }): void {
  if (process.env.REVIEW_LOG_EVENTS === "false") return
  const seen = new Set<string>()
  void client.event
    .subscribe()
    .then(async (sub) => {
      for await (const raw of sub.stream) {
        const ev = raw as { type: string; properties?: Record<string, unknown> }
        const key = eventKey(ev)
        if (seen.has(key)) continue
        const line = describeEvent(ev)
        if (!line) continue
        seen.add(key)
        console.log(`[review] ${line}`)
      }
    })
    .catch(() => {
      /* stream closed on server shutdown — nothing to do */
    })
}

/**
 * Resolve `{env:VAR}` placeholders inside a parsed config value (the same
 * convention OpenCode uses in its on-disk config). Lets a custom provider's
 * apiKey/headers reference an env var without baking the secret into the JSON.
 */
function resolveEnvPlaceholders(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Z0-9_]+)\}/g, (_m, name: string) => process.env[name] ?? "")
  }
  if (Array.isArray(value)) return value.map(resolveEnvPlaceholders)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveEnvPlaceholders(v)]),
    )
  }
  return value
}

/**
 * Boot an embedded OpenCode server and adapt its client to PromptClient.
 *
 * Model/provider: the model string comes from the caller (REVIEW_MODEL). To use a
 * provider other than the built-ins (e.g. an OpenAI-compatible gateway such as
 * Nebius Token Factory), set `OPENCODE_PROVIDER_JSON` to an OpenCode `provider`
 * block; it is merged into the config and `{env:VAR}` placeholders are resolved.
 *
 * Cast note: buildAgentConfig returns { agent: Record<string, AgentDef> } where
 * AgentDef.permission is Record<string, Action>. The SDK's Config.agent.*.permission
 * only enumerates specific known keys (edit, bash, webfetch, etc.) but uses an index
 * signature [key: string]: unknown, so the shape is structurally compatible at runtime.
 * We cast the config argument once here rather than threading the SDK type through our
 * internal agent builder.
 */
export async function createSdkClient(model: string, rules: Rule[]): Promise<SdkHandle> {
  // Derive W&B Weave OTEL env from WANDB_API_KEY/WANDB_PROJECT_ID (no-op otherwise).
  configureWandbOtel()

  const telemetryEnabled = process.env.OPENCODE_ENABLE_TELEMETRY === "1"
  if (telemetryEnabled && !process.env.OTEL_BSP_SCHEDULE_DELAY) {
    // Export spans ~every 500ms so they flush within the close() grace window.
    process.env.OTEL_BSP_SCHEDULE_DELAY = "500"
  }

  const config: Record<string, unknown> = { ...buildAgentConfig(model, rules) }
  const providerJson = process.env.OPENCODE_PROVIDER_JSON
  if (providerJson) {
    config.provider = resolveEnvPlaceholders(JSON.parse(providerJson) as unknown)
  }
  // Load the OTEL exporter plugin when telemetry is enabled (it reads the
  // OPENCODE_OTLP_* env vars itself); the plugin install is handled by OpenCode.
  if (process.env.OPENCODE_ENABLE_TELEMETRY === "1") {
    config.plugin = [OTEL_PLUGIN]
  }
  const { client, server } = await createOpencode({
    config: config as unknown as Config,
  })

  startEventLogger(client)

  return {
    client: {
      createSession: async () => {
        const result = await client.session.create({ body: { title: "layered-review" } })
        if (!result.data) {
          throw new Error(`Failed to create session: ${String(result.error)}`)
        }
        return { id: result.data.id }
      },
      prompt: async (sessionId: string, agent: string, text: string) => {
        const result = await client.session.prompt({
          path: { id: sessionId },
          body: { agent, parts: [{ type: "text", text }] },
        })
        if (!result.data) {
          throw new Error(`Prompt failed for session ${sessionId}: ${JSON.stringify(result.error)}`)
        }
        // Extract concatenated text from all text-type parts in the response
        const textContent = result.data.parts
          .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("")
        return { text: textContent || JSON.stringify(result.data.info) }
      },
    },
    // server.close() is synchronous in SDK 1.15.13; wrap to satisfy Promise<void>.
    // When telemetry is on, wait for the span exporter to flush before killing
    // the server — otherwise short-lived runs export nothing.
    close: async () => {
      if (telemetryEnabled) {
        await new Promise((resolve) => setTimeout(resolve, TELEMETRY_FLUSH_GRACE_MS))
      }
      server.close()
    },
  }
}
