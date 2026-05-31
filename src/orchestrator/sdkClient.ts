import { createOpencode } from "@opencode-ai/sdk"
import type { Config } from "@opencode-ai/sdk"
import type { PromptClient } from "./run"
import { buildAgentConfig } from "../opencode/agents"
import type { Rule } from "../config/schema"

export interface SdkHandle {
  client: PromptClient
  close: () => Promise<void>
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
  const config: Record<string, unknown> = { ...buildAgentConfig(model, rules) }
  const providerJson = process.env.OPENCODE_PROVIDER_JSON
  if (providerJson) {
    config.provider = resolveEnvPlaceholders(JSON.parse(providerJson) as unknown)
  }
  const { client, server } = await createOpencode({
    config: config as unknown as Config,
  })

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
          throw new Error(`Prompt failed for session ${sessionId}: ${String(result.error)}`)
        }
        // Extract concatenated text from all text-type parts in the response
        const textContent = result.data.parts
          .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("")
        return { text: textContent || JSON.stringify(result.data.info) }
      },
    },
    // server.close() is synchronous in SDK 1.15.13; wrap to satisfy Promise<void>
    close: async () => {
      server.close()
    },
  }
}
