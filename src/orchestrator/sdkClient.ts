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
 * Boot an embedded OpenCode server and adapt its client to PromptClient.
 *
 * Cast note: buildAgentConfig returns { agent: Record<string, AgentDef> } where
 * AgentDef.permission is Record<string, Action>. The SDK's Config.agent.*.permission
 * only enumerates specific known keys (edit, bash, webfetch, etc.) but uses an index
 * signature [key: string]: unknown, so the shape is structurally compatible at runtime.
 * We cast the config argument once here rather than threading the SDK type through our
 * internal agent builder.
 */
export async function createSdkClient(model: string, rules: Rule[]): Promise<SdkHandle> {
  const agentConfig = buildAgentConfig(model, rules)
  const { client, server } = await createOpencode({
    config: agentConfig as unknown as Config,
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
